import type { NowPlaying, PlaybackItem, QueueManagerSnapshot, QueueSourceRef, QueueStorage, Song, SourceCursor } from "@muswag/shared";
import { clonePlaybackItem, createUserPlaybackItem } from "@muswag/shared";
import { createStore } from "@tanstack/react-store";

import type { MpvQueueSnapshot, PlayerRuntimeState, QueuePlayerPort } from "#shared/player";
import { SerialQueue } from "#shared/serial-queue";
import type { QueueSourceFactory, SourceWindow } from "./source/queue-source";
import { VirtualSourceWindow } from "./source/virtual-source-window";

const TELEMETRY_SAVE_DELAY_MS = 5_000;
/** Past this point into a track, "previous" restarts it instead of stepping back. */
const RESTART_INSTEAD_OF_PREVIOUS_SECONDS = 5;

type ActiveSource = { ref: QueueSourceRef; window: VirtualSourceWindow };

export type QueueManagerState = {
  nowPlaying: NowPlaying | null;
  userQueue: readonly PlaybackItem[];
  source: { ref: QueueSourceRef; window: SourceWindow } | null;
};

type PendingSelection = { key: string; generation: number; candidate: ActiveSource | null };

export class QueueManager {
  readonly store = createStore<QueueManagerState>({ nowPlaying: null, userQueue: [], source: null });

  private readonly player: QueuePlayerPort;
  private readonly sources: QueueSourceFactory;
  private readonly storage: QueueStorage;
  private readonly serial = new SerialQueue();
  private readonly unsubscribePlayer: () => void;
  private activeSource: ActiveSource | null = null;
  private runtime: PlayerRuntimeState | null = null;
  private pendingSelection: PendingSelection | null = null;
  private selectionGeneration = 0;
  private selectionAbort: AbortController | null = null;
  private telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private disposed = false;

  constructor(options: { player: QueuePlayerPort; sources: QueueSourceFactory; storage: QueueStorage }) {
    this.player = options.player;
    this.sources = options.sources;
    this.storage = options.storage;
    this.unsubscribePlayer = this.player.subscribe((state) => this.acceptRuntime(state));
  }

  async restore(): Promise<boolean> {
    return this.serial.run(async () => {
      const initial = await this.player.getState();
      this.acceptRuntime(initial);
      const snapshot = await this.storage.load();
      if (!snapshot) return false;

      let active: ActiveSource | null = null;
      let repaired = false;
      if (snapshot.source) {
        try {
          active = await this.openWindow(snapshot.source.ref, { cursor: snapshot.source.cursor });
          repaired = !sameCursor(active.window.cursor, snapshot.source.cursor);
        } catch (cause) {
          console.error("[queue] failed to restore source", cause);
          repaired = true;
        }
      }

      const restoredState: QueueManagerState = {
        nowPlaying: snapshot.nowPlaying ? cloneNowPlaying(snapshot.nowPlaying) : null,
        userQueue: snapshot.userQueue.map(clonePlaybackItem),
        source: active ? publicSource(active) : null,
      };
      const nowPlaying = restoredState.nowPlaying;
      try {
        await this.player.applyQueue({
          snapshot: composeMpvQueue(restoredState),
          select: nowPlaying ? { key: nowPlaying.key, play: !snapshot.playback.paused, positionSeconds: snapshot.playback.positionSeconds } : undefined,
        });
      } catch (cause) {
        active?.window.dispose();
        console.error("[queue] failed to restore mpv mirror", cause);
        return false;
      }

      this.activeSource?.window.dispose();
      this.activeSource = active;
      this.publish(restoredState);
      if (repaired) this.saveLogicalState();
      return true;
    });
  }

  playSource(ref: QueueSourceRef, key: string): Promise<void> {
    const generation = ++this.selectionGeneration;
    this.selectionAbort?.abort();
    const controller = new AbortController();
    this.selectionAbort = controller;
    this.pendingSelection?.candidate?.window.dispose();
    this.pendingSelection = null;

    return this.serial.run(async () => {
      let candidate: ActiveSource | null = null;
      try {
        candidate = await this.openWindow(ref, { key }, controller.signal);
        if (controller.signal.aborted || generation !== this.selectionGeneration) {
          candidate.window.dispose();
          return;
        }
        const target = candidate.window.current;
        if (!target || target.key !== key) throw new Error(`Source occurrence ${key} is not playable.`);
        this.pendingSelection = { candidate, generation, key };
        const prospective: QueueManagerState = {
          nowPlaying: { ...clonePlaybackItem(target), origin: "source" },
          userQueue: this.store.state.userQueue,
          source: publicSource(candidate),
        };
        await this.player.applyQueue({ snapshot: composeMpvQueue(prospective), select: { key, play: true } });
      } catch (cause) {
        if (this.pendingSelection?.generation === generation) this.pendingSelection = null;
        candidate?.window.dispose();
        if (!controller.signal.aborted) throw cause;
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

  clearQueued(): Promise<void> {
    return this.serial.run(async () => {
      if (this.store.state.userQueue.length === 0) return;
      await this.commitQueueEdit({ ...this.store.state, userQueue: [] });
    });
  }

  next(): Promise<void> {
    return this.serial.run(async () => {
      const target = nextTarget(this.store.state);
      if (target) await this.select(target.key);
    });
  }

  previous(): Promise<void> {
    return this.serial.run(async () => {
      if (!this.store.state.nowPlaying) return;
      const target = (this.runtime?.positionSeconds ?? 0) > RESTART_INSTEAD_OF_PREVIOUS_SECONDS ? null : previousTarget(this.store.state);
      if (target) await this.select(target.key);
      else await this.player.restartCurrent();
    });
  }

  clear(): Promise<void> {
    ++this.selectionGeneration;
    this.selectionAbort?.abort();
    this.cancelTelemetrySave();
    return this.serial.run(async () => {
      this.cancelTelemetrySave();
      this.pendingSelection?.candidate?.window.dispose();
      this.pendingSelection = null;
      this.activeSource?.window.dispose();
      this.activeSource = null;
      await this.player.stop();
      this.publish({ nowPlaying: null, source: null, userQueue: [] });
      await this.clearPersistedState();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.selectionAbort?.abort();
    this.unsubscribePlayer();
    this.activeSource?.window.dispose();
    this.pendingSelection?.candidate?.window.dispose();
    if (this.telemetryTimer) clearTimeout(this.telemetryTimer);
  }

  private async openWindow(ref: QueueSourceRef, start: { key: string } | { cursor: SourceCursor }, signal?: AbortSignal): Promise<ActiveSource> {
    const source = this.sources.open(ref);
    let active: ActiveSource | null = null;
    const window = await VirtualSourceWindow.create({
      source,
      start,
      signal,
      onChange: () => {
        if (active && this.activeSource === active) void this.serial.run(() => this.sourceWindowChanged(active!));
      },
    });
    active = { ref: { ...ref }, window };
    return active;
  }

  private async sourceWindowChanged(active: ActiveSource): Promise<void> {
    if (this.activeSource !== active) return;
    const previousCursor = this.store.state.source?.window.cursor;
    this.publish({ ...this.store.state, source: publicSource(active) });
    if (previousCursor && !sameCursor(previousCursor, active.window.cursor)) this.saveLogicalState();
    await this.applyMirror();
  }

  private async select(key: string): Promise<void> {
    const generation = ++this.selectionGeneration;
    this.pendingSelection = { candidate: null, generation, key };
    try {
      await this.player.applyQueue({ snapshot: composeMpvQueue(this.store.state), select: { key, play: !(this.runtime?.paused ?? false) } });
    } catch (cause) {
      if (this.pendingSelection?.generation === generation) this.pendingSelection = null;
      throw cause;
    }
  }

  private acceptRuntime(runtime: PlayerRuntimeState): void {
    if (this.disposed || (this.runtime && runtime.sequence <= this.runtime.sequence)) return;
    this.runtime = structuredClone(runtime);
    void this.serial.run(() => this.commitRuntime(runtime));
  }

  private async commitRuntime(runtime: PlayerRuntimeState): Promise<void> {
    const key = runtime.current?.key;
    let logicalChanged = false;
    if (key && key !== this.store.state.nowPlaying?.key) {
      const firstUser = this.store.state.userQueue[0];
      const pending = this.pendingSelection?.key === key ? this.pendingSelection : null;
      if (firstUser?.key === key) {
        this.pendingSelection = null;
        this.publish({ ...this.store.state, nowPlaying: { ...clonePlaybackItem(firstUser), origin: "user" }, userQueue: this.store.state.userQueue.slice(1) });
        logicalChanged = true;
      } else {
        const source = pending?.candidate ?? (this.activeSource?.window.has(key) ? this.activeSource : null);
        if (source) {
          await this.commitSourceTransition(source, key, runtime.current!);
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

  private async commitSourceTransition(source: ActiveSource, key: string, current: PlaybackItem): Promise<void> {
    await source.window.moveTo(key);
    const previous = this.activeSource;
    this.activeSource = source;
    this.pendingSelection = null;
    this.publish({ ...this.store.state, nowPlaying: { ...clonePlaybackItem(current), origin: "source" }, source: publicSource(source) });
    if (previous !== source) previous?.window.dispose();
  }

  private applyMirror(): Promise<void> {
    if (!this.store.state.nowPlaying) return Promise.resolve();
    return this.player.applyQueue({ snapshot: composeMpvQueue(this.store.state) });
  }

  private async commitQueueEdit(next: QueueManagerState): Promise<void> {
    if (next.nowPlaying) await this.player.applyQueue({ snapshot: composeMpvQueue(next) });
    this.publish(next);
    this.saveLogicalState();
  }

  private publish(state: QueueManagerState): void {
    this.store.setState(() => structuredClone(state));
  }

  private scheduleTelemetrySave(): void {
    this.cancelTelemetrySave();
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

  private saveLogicalState(runtime = this.runtime): void {
    const state = this.store.state;
    const matchingRuntime = state.nowPlaying?.key === runtime?.current?.key ? runtime : null;
    const snapshot: QueueManagerSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      nowPlaying: state.nowPlaying ? cloneNowPlaying(state.nowPlaying) : null,
      userQueue: state.userQueue.map(clonePlaybackItem),
      source: state.source ? { ref: { ...state.source.ref }, cursor: { ...state.source.window.cursor } } : null,
      playback: { paused: matchingRuntime?.paused ?? false, positionSeconds: matchingRuntime?.positionSeconds ?? 0 },
    };
    void this.persist(() => this.storage.save(snapshot));
  }
}

export function composeMpvQueue(state: QueueManagerState): MpvQueueSnapshot {
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
  return { items: candidates.map(clonePlaybackItem) };
}

export function getQueueCanGoNext(state: QueueManagerState): boolean {
  return Boolean(nextTarget(state));
}

export function getQueueCanGoPrevious(state: QueueManagerState, runtime: PlayerRuntimeState | null): boolean {
  if (!state.nowPlaying) return false;
  return (runtime?.positionSeconds ?? 0) > 0 || Boolean(previousTarget(state));
}

/** The occurrence "next" would move to: the user queue always wins over the source. */
function nextTarget(state: QueueManagerState): PlaybackItem | undefined {
  return state.userQueue[0] ?? state.source?.window.next[0];
}

/** The occurrence "previous" would move to. A user-queued track steps back into the source it interrupted. */
function previousTarget(state: QueueManagerState): PlaybackItem | undefined {
  const source = state.source?.window;
  return (state.nowPlaying?.origin === "user" ? source?.current : undefined) ?? source?.previous.at(-1);
}

function publicSource(active: ActiveSource): NonNullable<QueueManagerState["source"]> {
  return { ref: { ...active.ref }, window: active.window.snapshot };
}

function cloneNowPlaying(item: NowPlaying): NowPlaying {
  return { ...clonePlaybackItem(item), origin: item.origin };
}

function sameCursor(left: SourceCursor, right: SourceCursor): boolean {
  return left.type === right.type && left.offset === right.offset && (left.type !== "item" || (right.type === "item" && left.key === right.key));
}
