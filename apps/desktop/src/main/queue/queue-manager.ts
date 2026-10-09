import type { NowPlaying, PlaybackItem, QueueSourceRef, Song, SourceCursor, SourceWindow } from "@muswag/model";
import { clonePlaybackItem, createUserPlaybackItem } from "@muswag/model";
import { createStore } from "@tanstack/store";

import { emptyQueueState, nextTarget, previousTarget, queueStateAt, sourceWindowItems, startTarget, type PlayingQueueState, type QueueManagerState } from "#shared/queue-state";
import { SerialQueue } from "./serial-queue";
import type { QueueStorage } from "./db-queue-storage";
import type { PlayerRuntimeState, QueuePlayerPort } from "./player-port";
import type { QueueSources, SourceAnchor } from "./source";
import type { UnplayableTrack } from "#shared/state/queue";

const TELEMETRY_SAVE_DELAY_MS = 5_000;
/** A library sync changes the library in bursts; the source playing is read again at most this often. */
const SOURCE_REFRESH_DELAY_MS = 250;
/** Past this point into a track, "previous" restarts it instead of stepping back. */
const RESTART_INSTEAD_OF_PREVIOUS_SECONDS = 5;
/** How many tracks in a row the queue moves past by itself because they cannot be played. When more fail, the tracks are unlikely to be the cause. */
const UNPLAYABLE_SKIPS = 3;
/**
 * A track is taken for unplayable only when it fails this soon after it was started. A server that
 * cannot be reached fails every track, slowly or after a while of playing, and moving on from those
 * would only lose the user's place.
 */
const UNPLAYABLE_WITHIN_MS = 20_000;

type Source = NonNullable<QueueManagerState["source"]>;

/**
 * The playback queue. It is on the occurrence the player holds, whatever the player is doing with it:
 * what the queue has the player play becomes its state once the player holds it, and where mpv moves
 * by itself the queue follows.
 */
export class QueueManager {
  readonly store = createStore<QueueManagerState>(emptyQueueState());

  private readonly player: QueuePlayerPort;
  private readonly sources: QueueSources;
  private readonly storage: QueueStorage;
  /** Everything that reads or changes the queue runs here, one at a time, so no step sees another half done. */
  private readonly serial = new SerialQueue();
  private readonly unsubscribePlayer: () => void;
  private readonly unsubscribeSources: () => void;
  /** The latest state of the player the queue has heard of. */
  private runtime: PlayerRuntimeState | null = null;
  /** Whether playback is paused. A track that ended or failed does not say, so this is from the last state that did. */
  private paused = false;
  /** How many more unplayable tracks the queue moves past by itself. It is back at the full count when a track plays or the user picks one. */
  private skipsLeft = UNPLAYABLE_SKIPS;
  /** The occurrence that was started and has not played yet, and when. A restored one is not started: it was playing before. */
  private started: { key: string; at: number } | null = null;
  /** Which way the user last stepped. An unplayable track is passed in that direction, so Previous does not bounce back off one. */
  private direction: 1 | -1 = 1;
  /** The songs that could not be played, by song id, for the lists to mark until they do play. */
  private readonly unplayable = new Map<string, UnplayableTrack>();
  private readonly onUnplayable: ((tracks: readonly UnplayableTrack[]) => void) | undefined;
  /** Counts the sources asked for and the times the queue was cleared: either replaces a request to play a source that has not run yet. */
  private sourceGeneration = 0;
  private telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private disposed = false;

  constructor(options: { player: QueuePlayerPort; sources: QueueSources; storage: QueueStorage; onUnplayable?: (tracks: readonly UnplayableTrack[]) => void }) {
    this.onUnplayable = options.onUnplayable;
    this.player = options.player;
    this.sources = options.sources;
    this.storage = options.storage;
    this.unsubscribePlayer = this.player.subscribe((state) => {
      if (this.observe(state)) void this.serial.run(() => this.followPlayer()).catch((cause) => console.error("[queue] playback transition failed", cause));
    });
    this.unsubscribeSources = this.sources.subscribe((affects) => {
      const source = this.store.state.source;
      if (source && affects(source.ref)) this.scheduleSourceRefresh();
    });
  }

  restore(): Promise<void> {
    return this.serial.run(async () => {
      this.observe(await this.player.getState());
      const stored = await this.storage.load();
      if (!stored) return;

      let source: Source | null = null;
      if (stored.source) {
        const { ref, cursor } = stored.source;
        try {
          // The source may have changed while the app was closed, so its window is read anew.
          const window = await this.sources.window(ref, anchorOf(cursor));
          source = window && { ref, window };
        } catch (cause) {
          console.error("[queue] failed to restore source", cause);
        }
      }

      const restored: QueueManagerState = {
        nowPlaying: stored.nowPlaying ? cloneNowPlaying(stored.nowPlaying) : null,
        userQueue: stored.userQueue.map(clonePlaybackItem),
        source,
      };
      const nowPlaying = restored.nowPlaying;
      // Without an occurrence playing there is nothing to load; the queue reaches mpv with the next selection.
      if (nowPlaying) {
        try {
          // Always restore paused: launching the app should never start audio by itself.
          await this.player.applyQueue({ items: composeMpvQueue(restored), select: { key: nowPlaying.key, play: false, positionSeconds: stored.resumePositionSeconds } });
        } catch (cause) {
          // The queue is the user's even when mpv cannot load it (mpv missing, say): keep it, so what main
          // holds matches what is stored and shown. Play loads it once the player can.
          console.error("[queue] failed to restore mpv mirror", cause);
        }
      }

      this.publish(restored);
    });
  }

  playSource(ref: QueueSourceRef, key: string): Promise<void> {
    // A later request, or clearing the queue, replaces this one: it then neither starts nor reports a failure.
    const generation = ++this.sourceGeneration;

    return this.serial.run(async () => {
      try {
        const window = await this.sources.window(ref, { key, offset: null });
        if (generation !== this.sourceGeneration) return;
        if (window?.current?.key !== key) throw new Error(`Source occurrence ${key} is not playable.`);
        this.skipsLeft = UNPLAYABLE_SKIPS;
        this.direction = 1;
        await this.playQueue({ nowPlaying: { ...clonePlaybackItem(window.current), origin: "source" }, userQueue: this.store.state.userQueue, source: { ref: { ...ref }, window } }, true);
      } catch (cause) {
        if (generation === this.sourceGeneration) throw cause;
      }
    });
  }

  /** Plays an occurrence the queue holds: a queued track, or one in the window of its source. */
  select(key: string): Promise<void> {
    return this.serial.run(() => {
      this.skipsLeft = UNPLAYABLE_SKIPS;
      this.direction = 1;
      return this.moveTo(key, true);
    });
  }

  /**
   * Starts the queue when the player holds no track: the occurrence playing, which the player could not
   * load when the queue was restored, say, or else the one that comes next. A track the player holds
   * is the player's own to play.
   */
  play(): Promise<void> {
    return this.serial.run(async () => {
      if (this.runtime?.current) return;
      this.skipsLeft = UNPLAYABLE_SKIPS;
      this.direction = 1;
      const target = startTarget(this.store.state);
      if (target) await this.moveTo(target.key, true);
    });
  }

  enqueue(tracks: readonly Song[]): Promise<void> {
    return this.serial.run(async () => {
      if (tracks.length === 0) return;
      const next = [...this.store.state.userQueue, ...tracks.map(createUserPlaybackItem)];
      await this.commitQueueEdit({ ...this.store.state, userQueue: next });
    });
  }

  removeQueued(key: string): Promise<void> {
    return this.serial.run(async () => {
      const next = this.store.state.userQueue.filter((item) => item.key !== key);
      if (next.length === this.store.state.userQueue.length) return;
      await this.commitQueueEdit({ ...this.store.state, userQueue: next });
    });
  }

  next(): Promise<void> {
    return this.serial.run(async () => {
      this.skipsLeft = UNPLAYABLE_SKIPS;
      this.direction = 1;
      const target = nextTarget(this.store.state);
      if (target) await this.moveTo(target.key);
    });
  }

  previous(): Promise<void> {
    return this.serial.run(async () => {
      this.skipsLeft = UNPLAYABLE_SKIPS;
      if (!this.store.state.nowPlaying) return;
      // A track that is still loading is at its start, so Previous steps back from it.
      const restarts = this.positionIn(this.store.state) > RESTART_INSTEAD_OF_PREVIOUS_SECONDS;
      const target = restarts ? undefined : previousTarget(this.store.state);
      this.direction = target ? -1 : 1;
      if (target) await this.moveTo(target.key);
      else await this.player.restartCurrent();
    });
  }

  clear(): Promise<void> {
    ++this.sourceGeneration;
    this.cancelTelemetrySave();
    return this.serial.run(async () => {
      this.cancelTelemetrySave();
      // The queue goes first, so that nothing of it is left here or stored when the player refuses to stop.
      this.store.setState(() => emptyQueueState());
      this.unplayable.clear();
      this.onUnplayable?.([]);
      try {
        await this.clearPersistedState();
      } finally {
        await this.player.stop();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribePlayer();
    this.unsubscribeSources();
    if (this.telemetryTimer) clearTimeout(this.telemetryTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private scheduleSourceRefresh(): void {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.serial.run(() => this.refreshSource()).catch((cause) => console.error("[queue] failed to refresh the source", cause));
    }, SOURCE_REFRESH_DELAY_MS);
  }

  /** Reads the source playing again after the library changed. Renderers and mpv hear of it only when its occurrences differ. */
  private async refreshSource(): Promise<void> {
    const state = this.store.state;
    if (!state.source || this.disposed) return;
    const window = await this.readWindow(state, state.source);
    if (sameOccurrences(window, state.source.window)) return;
    this.publish({ ...state, source: { ref: state.source.ref, window } });
    await this.mirror();
  }

  /**
   * The window of `source` where playback is in `state`. An occurrence playing from the source is looked
   * for by its key, also when it has left a gap, which is where it was: it may be back.
   */
  private async readWindow({ nowPlaying }: QueueManagerState, source: Source): Promise<SourceWindow> {
    const { cursor } = source.window;
    const at = nowPlaying?.origin === "source" ? { key: nowPlaying.key, offset: cursor.offset } : anchorOf(cursor);
    return (await this.sources.window(source.ref, at)) ?? source.window;
  }

  /** Has the player play the occurrence `key` of the queue. Its source is read again around it, which moves the window along. */
  private async moveTo(key: string, play = !this.paused): Promise<void> {
    const held = queueStateAt(this.store.state, key);
    if (!held) throw new Error(`Occurrence ${key} is not in the queue.`);
    await this.playQueue(await this.withWindowRead(held), play);
  }

  /** `state` with the window of its source read again, when that is where the occurrence playing is from. */
  private async withWindowRead(state: PlayingQueueState): Promise<PlayingQueueState> {
    const source = state.source;
    if (!source || state.nowPlaying.origin !== "source") return state;
    return { ...state, source: { ref: source.ref, window: await this.readWindow(state, source) } };
  }

  /** Has the player play the occurrence playing in `target`, with the rest of `target` as its queue. `target` is the queue once the player holds that occurrence. */
  private async playQueue(target: PlayingQueueState, play: boolean): Promise<void> {
    const key = target.nowPlaying.key;
    try {
      await this.player.applyQueue({ items: composeMpvQueue(target), select: { key, play } });
    } finally {
      // Where the player is decides, not how the command went: with mpv missing it holds the track it could not start.
      this.observe(await this.player.getState());
      if (this.runtime?.current?.key === key) {
        this.started = { key, at: Date.now() };
        this.publish(target, this.positionIn(target));
      }
    }
  }

  /** Takes in a state of the player, unless a later one is known. */
  private observe(runtime: PlayerRuntimeState): boolean {
    if (this.disposed || (this.runtime && runtime.epoch === this.runtime.epoch && runtime.sequence < this.runtime.sequence)) return false;
    this.runtime = structuredClone(runtime);
    if (runtime.status === "idle" || runtime.status === "loading" || runtime.status === "playing" || runtime.status === "paused") this.paused = runtime.paused;
    return true;
  }

  /** Brings the queue to where the player is: mpv moves on by itself when a track ends, and a track may turn out to be unplayable. */
  private async followPlayer(): Promise<void> {
    const current = this.runtime?.current;
    if (!current || this.disposed) return;
    if (current.key === this.store.state.nowPlaying?.key) {
      this.scheduleTelemetrySave();
    } else {
      const reached = await this.queueAt(current);
      if (!reached) return;
      this.started = { key: current.key, at: Date.now() };
      this.publish(reached, this.positionIn(reached));
      await this.mirror();
    }

    // The player may have moved on in the meantime; what it says now is what counts.
    const runtime = this.runtime;
    if (!runtime?.current || runtime.current.key !== this.store.state.nowPlaying?.key) return;
    if (runtime.status === "playing" || runtime.status === "paused") {
      this.skipsLeft = UNPLAYABLE_SKIPS;
      this.started = null;
      // From a track that plays, playback goes on forwards, whichever way the user got to it.
      this.direction = 1;
      if (this.unplayable.delete(runtime.current.track.id)) this.onUnplayable?.([...this.unplayable.values()]);
    } else if (runtime.trackFailed && this.started?.key === runtime.current.key && Date.now() - this.started.at <= UNPLAYABLE_WITHIN_MS) {
      await this.skipUnplayable(runtime.current);
    }
  }

  /** The queue with `current`, which the player moved to by itself, playing. `undefined` when it is no occurrence of this queue. */
  private async queueAt(current: PlaybackItem): Promise<PlayingQueueState | undefined> {
    const state = this.store.state;
    const held = queueStateAt(state, current.key);
    if (held) return this.withWindowRead(held);
    if (!state.source) return undefined;
    // A library change took the occurrence out of the window just as mpv started it. It plays on, and
    // is looked for in the source again: where it is now, or else the gap after the cursor, where it was.
    const {
      ref,
      window: { cursor },
    } = state.source;
    const window = await this.sources.window(ref, { key: current.key, offset: cursor.type === "item" ? cursor.offset + 1 : cursor.offset });
    return window ? { ...state, nowPlaying: { ...clonePlaybackItem(current), origin: "source" }, source: { ref, window } } : undefined;
  }

  /**
   * Moves past `failed`, a track that cannot be played, the way the user was going: as Next would, or as
   * Previous would after a step back. At either end of the queue, and once too many in a row have
   * failed, the queue stays where it is, with the player's failure showing. Either way the track is
   * marked for the lists.
   */
  private async skipUnplayable(failed: PlaybackItem): Promise<void> {
    const state = this.store.state;
    const target = this.skipsLeft > 0 ? (this.direction === 1 ? nextTarget(state) : previousTarget(state)) : undefined;
    // Having given up, the queue stays until the user moves it: a track queued later does not start by itself.
    this.skipsLeft = target ? this.skipsLeft - 1 : 0;
    this.unplayable.set(failed.track.id, { id: failed.track.id, title: failed.track.title, skipped: target !== undefined, at: Date.now() });
    this.onUnplayable?.([...this.unplayable.values()]);
    if (target) await this.moveTo(target.key);
  }

  /** Has the player hold `state` as its queue without changing what plays. With nothing playing mpv has no queue; it gets one with the next selection. */
  private async mirror(state: QueueManagerState = this.store.state): Promise<void> {
    if (state.nowPlaying) await this.player.applyQueue({ items: composeMpvQueue(state) });
  }

  private async commitQueueEdit(next: QueueManagerState): Promise<void> {
    await this.mirror(next);
    this.publish(next);
  }

  /**
   * Makes `state` current and stores it, which is how renderers see it. `resumePositionSeconds` goes
   * with a state in which another occurrence plays; `null` keeps the position stored.
   */
  private publish(state: QueueManagerState, resumePositionSeconds: number | null = null): void {
    this.store.setState(() => structuredClone(state));
    const published = this.store.state;
    void this.persist(() => this.storage.save(published, resumePositionSeconds));
  }

  /** Saves where playback has got to, once per delay: the player reports its position twice a second, so a save put off by every report would never run. */
  private scheduleTelemetrySave(): void {
    if (this.telemetryTimer) return;
    this.telemetryTimer = setTimeout(() => {
      this.telemetryTimer = null;
      const state = this.store.state;
      const position = this.positionIn(state);
      void this.persist(() => this.storage.save(state, position));
    }, TELEMETRY_SAVE_DELAY_MS);
  }

  private cancelTelemetrySave(): void {
    if (!this.telemetryTimer) return;
    clearTimeout(this.telemetryTimer);
    this.telemetryTimer = null;
  }

  /** Serialises storage writes so a later snapshot can never land before an earlier one. */
  private persist(operation: () => Promise<void>): Promise<void> {
    const persisting = this.saveChain.then(operation);
    this.saveChain = persisting.catch((cause) => console.error("[queue] persistence failed", cause));
    return persisting;
  }

  private clearPersistedState(): Promise<void> {
    return this.persist(() => this.storage.clear());
  }

  /** Where the player is in the occurrence playing in `state`, which is where it would resume after a restart. Zero when the player holds another. */
  private positionIn(state: QueueManagerState): number {
    return this.runtime && this.runtime.current?.key === state.nowPlaying?.key ? this.runtime.positionSeconds : 0;
  }
}

export function composeMpvQueue(state: QueueManagerState): PlaybackItem[] {
  const source = state.source?.window;
  const candidates: PlaybackItem[] = [
    ...(source?.previous ?? []),
    ...(source?.current && source.current.key !== state.nowPlaying?.key ? [source.current] : []),
    ...(state.nowPlaying ? [state.nowPlaying] : []),
    ...state.userQueue,
    ...(source?.next ?? []),
  ];
  const keys = new Set<string>();
  for (const item of candidates) {
    if (keys.has(item.key)) throw new Error(`Duplicate playback occurrence key: ${item.key}`);
    keys.add(item.key);
  }
  return candidates.map(clonePlaybackItem);
}

const anchorOf = (cursor: SourceCursor): SourceAnchor => ({ key: cursor.type === "item" ? cursor.key : null, offset: cursor.offset });

/** Whether two windows hold the same occurrences at the same places. What is known about their tracks may differ. */
function sameOccurrences(left: SourceWindow, right: SourceWindow): boolean {
  const places = (window: SourceWindow) => sourceWindowItems(window).map(({ key, offset }) => `${offset}:${key}`);
  return sameCursor(left.cursor, right.cursor) && left.hasMore === right.hasMore && places(left).join("\n") === places(right).join("\n");
}

function cloneNowPlaying(item: NowPlaying): NowPlaying {
  return { ...clonePlaybackItem(item), origin: item.origin };
}

function sameCursor(left: SourceCursor, right: SourceCursor): boolean {
  return left.type === right.type && left.offset === right.offset && (left.type !== "item" || (right.type === "item" && left.key === right.key));
}
