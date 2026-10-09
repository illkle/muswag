import type { NowPlaying, PlaybackItem, QueueSourceRef, Song, SourceCursor, SourceWindow } from "@muswag/model";
import { clonePlaybackItem, createUserPlaybackItem } from "@muswag/model";
import { createStore } from "@tanstack/store";

import { nextTarget, previousTarget, sourceWindowItems, type QueueManagerState } from "#shared/queue-state";
import { SerialQueue } from "./serial-queue";
import type { QueueStorage } from "./db-queue-storage";
import type { PlayerRuntimeState, QueuePlayerPort } from "./player-port";
import type { QueueSources, SourceAnchor } from "./source";

const TELEMETRY_SAVE_DELAY_MS = 5_000;
/** A library sync changes the library in bursts; the source playing is read again at most this often. */
const SOURCE_REFRESH_DELAY_MS = 250;
/** Past this point into a track, "previous" restarts it instead of stepping back. */
const RESTART_INSTEAD_OF_PREVIOUS_SECONDS = 5;

type Source = NonNullable<QueueManagerState["source"]>;

/** A selection mpv was given that has not started. `candidate` is the source it was asked from, when it is a new one. */
type PendingSelection = { key: string; candidate: Source | null };

export class QueueManager {
  readonly store = createStore<QueueManagerState>({ nowPlaying: null, userQueue: [], source: null });

  private readonly player: QueuePlayerPort;
  private readonly sources: QueueSources;
  private readonly storage: QueueStorage;
  /** Everything that reads or changes the queue runs here, one at a time, so no step sees another half done. */
  private readonly serial = new SerialQueue();
  private readonly unsubscribePlayer: () => void;
  private readonly unsubscribeSources: () => void;
  private runtime: PlayerRuntimeState | null = null;
  private pendingSelection: PendingSelection | null = null;
  /** Counts the sources asked for and the times the queue was cleared: either replaces a request to play a source that has not run yet. */
  private sourceGeneration = 0;
  private telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private disposed = false;

  constructor(options: { player: QueuePlayerPort; sources: QueueSources; storage: QueueStorage }) {
    this.player = options.player;
    this.sources = options.sources;
    this.storage = options.storage;
    this.unsubscribePlayer = this.player.subscribe((state) => this.acceptRuntime(state));
    this.unsubscribeSources = this.sources.subscribe((affects) => {
      const source = this.store.state.source;
      if (source && affects(source.ref)) this.scheduleSourceRefresh();
    });
  }

  async restore(): Promise<boolean> {
    return this.serial.run(async () => {
      const initial = await this.player.getState();
      this.acceptRuntime(initial);
      const stored = await this.storage.load();
      if (!stored) return false;

      let source: Source | null = null;
      let repaired = false;
      if (stored.source) {
        const { ref, cursor } = stored.source;
        try {
          // The source may have changed while the app was closed, so its window is read anew.
          const window = await this.sources.window(ref, anchorOf(cursor));
          source = window && { ref, window };
          repaired = !window || !sameCursor(window.cursor, cursor);
        } catch (cause) {
          console.error("[queue] failed to restore source", cause);
          repaired = true;
        }
      }

      const restoredState: QueueManagerState = {
        nowPlaying: stored.nowPlaying ? cloneNowPlaying(stored.nowPlaying) : null,
        userQueue: stored.userQueue.map(clonePlaybackItem),
        source,
      };
      const nowPlaying = restoredState.nowPlaying;
      // Without an occurrence playing there is nothing to load; the queue reaches mpv with the next selection.
      if (nowPlaying) {
        try {
          // Always restore paused: launching the app should never start audio by itself.
          await this.player.applyQueue({ items: composeMpvQueue(restoredState), select: { key: nowPlaying.key, play: false, positionSeconds: stored.resumePositionSeconds } });
        } catch (cause) {
          // The queue is the user's even when mpv cannot load it (mpv missing, say): keep it, so what main
          // holds matches what is stored and shown, and let the next selection load it.
          console.error("[queue] failed to restore mpv mirror", cause);
        }
      }

      this.publish(restoredState);
      if (repaired) this.saveLogicalState();
      return true;
    });
  }

  playSource(ref: QueueSourceRef, key: string): Promise<void> {
    // A later request, or clearing the queue, replaces this one: it then neither starts nor reports a failure.
    const generation = ++this.sourceGeneration;
    this.pendingSelection = null;

    return this.serial.run(async () => {
      let pending: PendingSelection | null = null;
      try {
        const window = await this.sources.window(ref, { key, offset: null });
        if (generation !== this.sourceGeneration) return;
        if (window?.current?.key !== key) throw new Error(`Source occurrence ${key} is not playable.`);
        pending = { candidate: { ref: { ...ref }, window }, key };
        this.pendingSelection = pending;
        await this.player.applyQueue({ items: composeMpvQueue(this.mirrorState()), select: { key, play: true } });
      } catch (cause) {
        if (this.pendingSelection === pending) this.pendingSelection = null;
        if (generation === this.sourceGeneration) throw cause;
      }
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
      const target = this.neighbour(1);
      if (target) await this.select(target.key);
    });
  }

  previous(): Promise<void> {
    return this.serial.run(async () => {
      // A selection that has not started has no position to restart from: Previous steps back from it.
      const pending = this.pendingSelection !== null;
      if (!pending && !this.store.state.nowPlaying) return;
      const restarts = !pending && (this.runtime?.positionSeconds ?? 0) > RESTART_INSTEAD_OF_PREVIOUS_SECONDS;
      const target = restarts ? undefined : this.neighbour(-1);
      if (target) await this.select(target.key);
      else await this.player.restartCurrent();
    });
  }

  clear(): Promise<void> {
    ++this.sourceGeneration;
    this.cancelTelemetrySave();
    return this.serial.run(async () => {
      this.cancelTelemetrySave();
      this.pendingSelection = null;
      await this.player.stop();
      this.publish({ nowPlaying: null, source: null, userQueue: [] });
      await this.clearPersistedState();
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
    const { source, nowPlaying } = this.store.state;
    if (!source || this.disposed) return;
    // A gap is where the occurrence playing was. It is looked for again, since it may be back.
    const at = nowPlaying?.origin === "source" ? { key: nowPlaying.key, offset: source.window.cursor.offset } : anchorOf(source.window.cursor);
    const window = await this.sources.window(source.ref, at);
    if (!window || sameOccurrences(window, source.window)) return;
    this.publish({ ...this.store.state, source: { ref: source.ref, window } });
    if (!sameCursor(window.cursor, source.window.cursor)) this.saveLogicalState();
    await this.applyMirror();
  }

  /**
   * `state` as mpv holds it. A source that was asked for is in mpv before it starts playing, and is
   * what Next and Previous step through until it does.
   */
  private mirrorState(state: QueueManagerState = this.store.state): QueueManagerState {
    const candidate = this.pendingSelection?.candidate;
    const current = candidate?.window.current;
    if (!candidate || !current) return state;
    return { nowPlaying: { ...clonePlaybackItem(current), origin: "source" }, userQueue: state.userQueue, source: candidate };
  }

  /**
   * The occurrence one step from the one playing. While a selection is still loading the step is
   * taken from it instead, so pressing Next again moves on rather than selecting the same track.
   */
  private neighbour(direction: 1 | -1): PlaybackItem | undefined {
    const state = this.mirrorState();
    const pending = this.pendingSelection;
    if (pending) {
      const items = composeMpvQueue(state);
      const index = items.findIndex((item) => item.key === pending.key);
      if (index >= 0) return items[index + direction];
    }
    return direction === 1 ? nextTarget(state) : previousTarget(state);
  }

  private async select(key: string): Promise<void> {
    const pending: PendingSelection = { candidate: this.pendingSelection?.candidate ?? null, key };
    // Queued tracks skipped on the way to `key` leave the queue, as they do when stepped through one at a time.
    const keys = composeMpvQueue(this.mirrorState()).map((item) => item.key);
    const passed = new Set(keys.slice(0, Math.max(0, keys.indexOf(key))));
    const state = this.store.state;
    const next = { ...state, userQueue: state.userQueue.filter((item) => !passed.has(item.key)) };
    this.pendingSelection = pending;
    try {
      await this.player.applyQueue({ items: composeMpvQueue(this.mirrorState(next)), select: { key, play: !(this.runtime?.paused ?? false) } });
    } catch (cause) {
      if (this.pendingSelection === pending) this.pendingSelection = null;
      throw cause;
    }
    if (next.userQueue.length !== state.userQueue.length) this.publish(next);
  }

  private acceptRuntime(runtime: PlayerRuntimeState): void {
    if (this.disposed || (this.runtime && runtime.epoch === this.runtime.epoch && runtime.sequence <= this.runtime.sequence)) return;
    this.runtime = structuredClone(runtime);
    void this.serial.run(() => this.commitRuntime(runtime)).catch((cause) => console.error("[queue] playback transition failed", cause));
  }

  private async commitRuntime(runtime: PlayerRuntimeState): Promise<void> {
    if (runtime.status === "loading" || runtime.status === "error" || runtime.status === "idle") return;
    const key = runtime.current?.key;
    // Playback has got to what was selected. A selection it has not got to stays, for Next and Previous to step on from.
    const pending = this.pendingSelection?.key === key ? this.pendingSelection : null;
    if (pending) this.pendingSelection = null;
    let logicalChanged = false;
    // A source asked for at the occurrence already playing still has to become the active one.
    if (key && (key !== this.store.state.nowPlaying?.key || pending?.candidate)) {
      const state = this.store.state;
      const firstUser = state.userQueue[0];
      if (firstUser?.key === key) {
        this.publish({ nowPlaying: { ...clonePlaybackItem(firstUser), origin: "user" }, userQueue: state.userQueue.slice(1), source: pending?.candidate ?? state.source });
        logicalChanged = true;
      } else {
        const source = pending?.candidate ?? state.source;
        const reached = source && sourceWindowItems(source.window).find((item) => item.key === key);
        if (source && reached) {
          await this.commitSourceTransition(source, reached.offset, runtime.current!);
          logicalChanged = true;
        }
      }
    }

    if (logicalChanged) {
      this.saveLogicalState(runtime);
      await this.applyMirror();
    } else if (runtime.current?.key === this.store.state.nowPlaying?.key) {
      this.scheduleTelemetrySave();
    }
  }

  /** Playback has got to `current`, at `offset` of `source`: the window moves there, and `source` is what playback reads from. */
  private async commitSourceTransition(source: Source, offset: number, current: PlaybackItem): Promise<void> {
    // An occurrence that left the source while it was starting leaves a gap where it was.
    const window = (await this.sources.window(source.ref, { key: current.key, offset })) ?? source.window;
    this.publish({ ...this.store.state, nowPlaying: { ...clonePlaybackItem(current), origin: "source" }, source: { ref: source.ref, window } });
  }

  private applyMirror(): Promise<void> {
    const mirror = this.mirrorState();
    if (!mirror.nowPlaying) return Promise.resolve();
    return this.player.applyQueue({ items: composeMpvQueue(mirror) });
  }

  private async commitQueueEdit(next: QueueManagerState): Promise<void> {
    const mirror = this.mirrorState(next);
    if (mirror.nowPlaying) await this.player.applyQueue({ items: composeMpvQueue(mirror) });
    this.publish(next);
    this.saveLogicalState();
  }

  /** Makes `state` current and stores it, which is how renderers see it. */
  private publish(state: QueueManagerState): void {
    this.store.setState(() => structuredClone(state));
    const published = this.store.state;
    void this.persist(() => this.storage.save(published, null));
  }

  /** Saves where playback has got to, once per delay: the player reports its position twice a second, so a save put off by every report would never run. */
  private scheduleTelemetrySave(): void {
    if (this.telemetryTimer) return;
    this.telemetryTimer = setTimeout(() => {
      this.telemetryTimer = null;
      this.saveLogicalState();
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

  /** Stores where playback would resume after a restart. */
  private saveLogicalState(runtime = this.runtime): void {
    const state = this.store.state;
    const matchingRuntime = state.nowPlaying?.key === runtime?.current?.key ? runtime : null;
    void this.persist(() => this.storage.save(state, matchingRuntime?.positionSeconds ?? 0));
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
