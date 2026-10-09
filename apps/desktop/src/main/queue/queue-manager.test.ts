import { afterEach, describe, expect, it, vi } from "vitest";

import { songRow, type PlaybackItem, type QueueSourceRef, type Song, type SourceCursor, type SourceItem, type SourceWindow } from "@muswag/model";
import type { QueueManagerState } from "#shared/queue-state";
import type { QueueSources, SourceAnchor } from "./source";
import { DbQueueStorage, type QueueStorage, type QueueTables, type StoredQueue } from "./db-queue-storage";
import type { ApplyQueueInput, PlayerRuntimeState, QueuePlayerPort } from "./player-port";
import { QueueManager } from "./queue-manager";

const song = (id: string): Song => songRow({ id, title: id });
const sourceItem = (key: string, offset: number): SourceItem => ({ key, offset, track: song(key) });

class FakePlayer implements QueuePlayerPort {
  state: PlayerRuntimeState = { sequence: 0, current: null, status: "idle", positionSeconds: 0, paused: false, trackFailed: false };
  listeners = new Set<(state: PlayerRuntimeState) => void>();
  applies: ApplyQueueInput[] = [];
  applyError: Error | null = null;
  /** Whether a selection that fails with `applyError` is held all the same, as one is that mpv could not start. */
  holdsWhatItRefuses = false;
  stopError: Error | null = null;
  restarts = 0;

  /** As the player does, it holds a selection from the moment it takes the command; the track starts later. */
  async applyQueue(input: ApplyQueueInput): Promise<void> {
    this.applies.push(structuredClone(input));
    const { select } = input;
    const selected = select && input.items.find(({ key }) => key === select.key);
    if (selected && (!this.applyError || this.holdsWhatItRefuses)) {
      const status = this.applyError ? "error" : "loading";
      this.state = { ...this.state, current: structuredClone(selected), status, positionSeconds: select.positionSeconds ?? 0, paused: !select.play, trackFailed: false };
    }
    if (this.applyError) throw this.applyError;
  }
  async restartCurrent(): Promise<void> {
    this.restarts += 1;
  }
  async stop(): Promise<void> {
    if (this.stopError) throw this.stopError;
  }
  async getState(): Promise<PlayerRuntimeState> {
    return this.state;
  }
  subscribe(listener: (state: PlayerRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The player says what it is doing with `item`. */
  report(item: PlaybackItem, sequence: number, state: Partial<PlayerRuntimeState>): void {
    this.state = { ...this.state, trackFailed: false, ...state, sequence, current: structuredClone(item) };
    for (const listener of this.listeners) listener(this.state);
  }
  start(item: PlaybackItem, sequence: number, positionSeconds = 0): void {
    this.report(item, sequence, { status: "playing", paused: false, positionSeconds });
  }
  /** The player holds `item`, which has not started yet: one it was told to play, or one mpv moved on to. */
  load(item: PlaybackItem, sequence: number): void {
    this.report(item, sequence, { status: "loading", positionSeconds: 0 });
  }
  /** Playback of `item` failed: because the track cannot be played, or for another reason. */
  fail(item: PlaybackItem, sequence: number, trackFailed = true): void {
    this.report(item, sequence, { status: "error", trackFailed });
  }
}

/** Albums kept in memory, each a list of occurrence keys in order, read whole. */
class FakeSources implements QueueSources {
  listeners = new Set<(affects: (ref: QueueSourceRef) => boolean) => void>();
  constructor(readonly albums: Record<string, string[]> = { album: ["a", "c"] }) {}

  async window(ref: QueueSourceRef, at: SourceAnchor): Promise<SourceWindow | null> {
    const items = (ref.type === "album" ? (this.albums[ref.albumId] ?? []) : []).map(sourceItem);
    const found = items.findIndex(({ key }) => key === at.key);
    if (found < 0 && at.offset === null) return null;
    const cursor: SourceCursor = found < 0 ? { type: "gap", offset: at.offset! } : { type: "item", key: at.key!, offset: found };
    return { cursor, previous: items.slice(0, cursor.offset), current: items[found] ?? null, next: items.slice(found < 0 ? cursor.offset : found + 1), hasMore: false };
  }
  subscribe(listener: (affects: (ref: QueueSourceRef) => boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The library changed in a way that may touch any source. */
  changed(): void {
    for (const listener of this.listeners) listener(() => true);
  }
}

class MemoryStorage implements QueueStorage {
  /** What `load` returns. */
  stored: StoredQueue | null = null;
  saved: { state: QueueManagerState; resumePositionSeconds: number } | null = null;
  async load() {
    return this.stored;
  }
  async save(state: QueueManagerState, resumePositionSeconds: number | null) {
    this.saved = structuredClone({ state, resumePositionSeconds: resumePositionSeconds ?? this.saved?.resumePositionSeconds ?? 0 });
  }
  async clear() {
    this.stored = null;
    this.saved = null;
  }
}

const album = { type: "album" as const, albumId: "album" };
const factory = new FakeSources();
const occurrence = (key: string): PlaybackItem => ({ key, track: song(key) });
/** The occurrences the player was told to play, in order. */
const selections = (player: FakePlayer) => player.applies.flatMap(({ select }) => (select ? [select.key] : []));

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("QueueManager", () => {
  afterEach(() => vi.useRealTimers());

  it("restores embedded snapshots, source cursor and position, always paused, before publishing", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    storage.stored = {
      nowPlaying: { key: "a", origin: "source", track: song("embedded-deleted-library-row") },
      userQueue: [{ key: "user:saved", track: song("queued") }],
      source: { ref: { type: "album", albumId: "album" }, cursor: { type: "item", key: "a", offset: 0 } },
      resumePositionSeconds: 42,
    };
    const manager = new QueueManager({ player, sources: factory, storage });

    await manager.restore();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a", track: { id: "embedded-deleted-library-row" } }, source: { window: { cursor: { key: "a", offset: 0 } } } });
    expect(player.applies.at(-1)?.select).toEqual({ key: "a", play: false, positionSeconds: 42 });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["a", "user:saved", "c"]);
    manager.dispose();
  });

  it("restores a queue with nothing playing without loading it, and keeps a queue mpv cannot load, for Play to start", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    storage.stored = { nowPlaying: null, userQueue: [{ key: "user:saved", track: song("queued") }], source: null, resumePositionSeconds: 0 };
    const idle = new QueueManager({ player, sources: factory, storage });
    await idle.restore();
    expect(player.applies).toEqual([]);
    expect(idle.store.state.userQueue.map(({ key }) => key)).toEqual(["user:saved"]);
    idle.dispose();

    storage.stored = { ...storage.stored, nowPlaying: { key: "user:now", origin: "user", track: song("now") } };
    player.applyError = new Error("mpv is missing");
    const broken = new QueueManager({ player, sources: factory, storage });
    await broken.restore();
    expect(broken.store.state).toMatchObject({ nowPlaying: { key: "user:now" }, userQueue: [{ key: "user:saved" }] });

    // The player holds nothing, so Play is the queue's: it loads what the queue says is playing.
    player.applyError = null;
    await broken.play();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: "user:now", play: true }, items: [{ key: "user:now" }, { key: "user:saved" }] });
    expect(broken.store.state).toMatchObject({ nowPlaying: { key: "user:now" }, userQueue: [{ key: "user:saved" }] });
    broken.dispose();
  });

  it("starts the queue with Play when nothing is playing, and leaves Play to the player once it holds a track", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });
    await manager.play();
    expect(player.applies).toEqual([]);

    await manager.enqueue([song("x"), song("y")]);
    const [x, y] = manager.store.state.userQueue;
    await manager.play();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: x!.key, play: true }, items: [{ key: x!.key }, { key: y!.key }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: x!.key, origin: "user" }, userQueue: [{ key: y!.key }] });

    await manager.play();
    expect(selections(player)).toEqual([x!.key]);
    manager.dispose();
  });

  it("is on a selection once the player holds it, and keeps manual items out of source history", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });

    // A selection the player turned down without taking it is not the queue's either.
    player.applyError = new Error("the player is busy");
    await expect(manager.playSource({ type: "album", albumId: "album" }, "a")).rejects.toThrow("the player is busy");
    expect(manager.store.state).toEqual({ nowPlaying: null, userQueue: [], source: null });
    player.applyError = null;

    await manager.playSource({ type: "album", albumId: "album" }, "a");
    expect(manager.store.state.nowPlaying).toMatchObject({ key: "a", origin: "source" });
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    expect(manager.store.state.nowPlaying).toMatchObject({ key: "a", origin: "source" });

    await manager.enqueue([song("b")]);
    const user = manager.store.state.userQueue[0]!;
    await manager.next();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: user.key, origin: "user" }, userQueue: [] });
    player.start(user, 2);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: user.key, origin: "user" }, userQueue: [] });

    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("c");
    player.start({ key: "c", track: song("c") }, 3);
    await flush();
    await manager.previous();
    expect(player.applies.at(-1)?.select?.key).toBe("a");
    manager.dispose();
  });

  it("steps on from an occurrence that is still loading, and drops the queued tracks it skips", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start({ key: "a", track: song("a") }, 1, 30);
    await flush();
    await manager.enqueue([song("x"), song("y")]);
    const [x, y] = manager.store.state.userQueue;

    await manager.next();
    player.load(x!, 2);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: x!.key, origin: "user" }, userQueue: [{ key: y!.key }] });
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe(y!.key);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: y!.key, origin: "user" }, userQueue: [] });
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("b");
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["a", "b", "c"]);
    expect(manager.store.state.userQueue).toEqual([]);

    // Nothing has started since, so Previous steps back although "a" is past five seconds.
    await manager.previous();
    expect(player.applies.at(-1)?.select?.key).toBe("a");
    await manager.next();
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("c");
    await manager.next();
    expect(selections(player)).toEqual(["a", x!.key, y!.key, "b", "a", "b", "c"]);

    player.start({ key: "c", track: song("c") }, 3, 30);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "c", origin: "source" }, source: { window: { cursor: { key: "c", offset: 2 } } } });
    await manager.previous();
    expect(player.restarts).toBe(1);
    manager.dispose();
  });

  it("steps through a source that is still starting, and plays from it", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "c"], second: ["p", "q"] }), storage: new MemoryStorage() });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    await manager.enqueue([song("x")]);
    const x = manager.store.state.userQueue[0]!;

    await manager.playSource({ type: "album", albumId: "second" }, "p");
    await manager.next();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: x.key }, items: [{ key: "p" }, { key: x.key }, { key: "q" }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: x.key }, source: { ref: { albumId: "second" } } });
    player.start(x, 2);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: x.key, origin: "user" }, userQueue: [], source: { ref: { albumId: "second" }, window: { cursor: { key: "p" } } } });

    await manager.playSource({ type: "album", albumId: "album" }, "a");
    await manager.next();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: "c" }, items: [{ key: "a" }, { key: "c" }] });
    player.start({ key: "c", track: song("c") }, 3);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "c", origin: "source" }, source: { ref: { albumId: "album" }, window: { cursor: { key: "c", offset: 1 } } } });
    manager.dispose();
  });

  it("keeps queued tracks when a source starts, and plays them from the queue", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });
    await manager.enqueue([song("queued")]);
    const queued = manager.store.state.userQueue[0]!;
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    expect(manager.store.state.userQueue[0]?.key).toBe(queued.key);
    player.start(queued, 2);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: queued.key, origin: "user" }, userQueue: [] });
    manager.dispose();
  });

  it("gives duplicate user songs unique occurrences and restarts Previous past five seconds", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });
    await manager.enqueue([song("same"), song("same")]);
    expect(manager.store.state.userQueue[0]?.key).not.toBe(manager.store.state.userQueue[1]?.key);

    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1, 6);
    await flush();
    await manager.previous();
    expect(player.restarts).toBe(1);
    manager.dispose();
  });

  it("stores every published state, and the resume position only when playback is saved", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    expect(storage.saved).toMatchObject({ state: { nowPlaying: { key: "a" } }, resumePositionSeconds: 0 });
    player.start({ key: "a", track: song("a") }, 1, 7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.saved).toMatchObject({ state: { nowPlaying: { key: "a" } }, resumePositionSeconds: 7 });

    await manager.enqueue([song("queued")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.saved?.state.userQueue.map(({ track }) => track.id)).toEqual(["queued"]);
    expect(storage.saved?.resumePositionSeconds).toBe(7);

    // Another occurrence starts from its own beginning.
    await manager.next();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.saved).toMatchObject({ state: { nowPlaying: { track: { id: "queued" } } }, resumePositionSeconds: 0 });
    manager.dispose();
  });

  it("saves only the resume position while a track plays, which no renderer hears of", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const writes: Parameters<QueueTables["write"]>[0][] = [];
    const tables: QueueTables = { load: async () => ({ state: null, items: [], resumePositionSeconds: 0 }), write: async (change) => void writes.push(change), clear: async () => {} };
    const manager = new QueueManager({ player, sources: factory, storage: new DbQueueStorage(tables) });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await vi.advanceTimersByTimeAsync(0);
    const written = writes.length;

    for (let tick = 1; tick <= 20; tick++) {
      player.start(occurrence("a"), 1 + tick, tick / 2);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(writes.length).toBeGreaterThan(written);
    for (const change of writes.slice(written)) expect(change).toEqual({ upsert: [], remove: [], state: null, resumePositionSeconds: expect.any(Number) });
    manager.dispose();
  });

  it("does not publish or persist queue edits that mpv rejects", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.enqueue([song("queued-a"), song("queued-b")]);
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    const before = structuredClone(manager.store.state.userQueue);
    player.applyError = new Error("mpv rejected queue");

    await expect(manager.enqueue([song("queued-c")])).rejects.toThrow("mpv rejected queue");
    await expect(manager.removeQueued(before[0]!.key)).rejects.toThrow("mpv rejected queue");

    expect(manager.store.state.userQueue).toEqual(before);
    expect(storage.saved?.state.userQueue).toEqual(before);
    manager.dispose();
  });

  it("reads its source again when the library changes, and tells mpv only when its occurrences differ", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const sources = new FakeSources({ album: ["a", "c"] });
    const manager = new QueueManager({ player, sources, storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await vi.advanceTimersByTimeAsync(0);
    const applied = player.applies.length;

    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(player.applies).toHaveLength(applied);

    // A burst of changes, as a sync makes them, is read once.
    sources.albums.album = ["b", "a", "c", "d"];
    sources.changed();
    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.store.state.source?.window).toMatchObject({ cursor: { key: "a", offset: 1 }, previous: [{ key: "b" }], next: [{ key: "c" }, { key: "d" }] });
    expect(player.applies).toHaveLength(applied + 1);
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["b", "a", "c", "d"]);
    expect(player.applies.at(-1)?.select).toBeUndefined();

    // The occurrence playing leaves the source: it plays on, with a gap where it was.
    sources.albums.album = ["b", "c", "d"];
    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a" }, source: { window: { cursor: { type: "gap", offset: 1 }, current: null, next: [{ key: "c" }, { key: "d" }] } } });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["b", "a", "c", "d"]);

    // And comes back, somewhere else: the cursor is on it again, so it is not in the queue twice.
    sources.albums.album = ["b", "c", "a", "d"];
    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.store.state.source?.window).toMatchObject({ cursor: { type: "item", key: "a", offset: 2 }, current: { key: "a" }, next: [{ key: "d" }] });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["b", "c", "a", "d"]);

    // A change still waiting to be read when the queue is disposed is not read.
    const reads = vi.spyOn(sources, "window");
    sources.changed();
    manager.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(reads).not.toHaveBeenCalled();
  });

  it("plays a source asked for right after a step that has not run yet", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c"], second: ["p", "q"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await flush();

    // Both wait behind each other; the step must not cancel the request that follows it.
    const stepped = manager.next();
    const asked = manager.playSource({ type: "album", albumId: "second" }, "p");
    await Promise.all([stepped, asked]);

    expect(selections(player)).toEqual(["a", "b", "p"]);
    manager.dispose();
  });

  it("plays from a source that changed while it was starting", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const sources = new FakeSources({ album: ["a", "c"], second: ["p", "q"] });
    const manager = new QueueManager({ player, sources, storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await vi.advanceTimersByTimeAsync(0);

    await manager.playSource({ type: "album", albumId: "second" }, "p");
    sources.albums.second = ["o", "p", "q"];
    sources.changed();
    player.start({ key: "p", track: song("p") }, 2);
    await vi.advanceTimersByTimeAsync(300);

    expect(manager.store.state).toMatchObject({
      nowPlaying: { key: "p", origin: "source" },
      source: { ref: { albumId: "second" }, window: { cursor: { key: "p", offset: 1 }, previous: [{ key: "o" }], next: [{ key: "q" }] } },
    });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["o", "p", "q"]);
    manager.dispose();
  });

  it("serializes clearing after an in-flight save", async () => {
    let releaseSave!: () => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    class DelayedStorage extends MemoryStorage {
      clearCalls = 0;
      override async save(state: QueueManagerState, resumePositionSeconds: number | null): Promise<void> {
        markSaveStarted();
        await saveGate;
        await super.save(state, resumePositionSeconds);
      }
      override async clear(): Promise<void> {
        this.clearCalls += 1;
        await super.clear();
      }
    }
    const storage = new DelayedStorage();
    const manager = new QueueManager({ player: new FakePlayer(), sources: factory, storage });
    await manager.enqueue([song("queued")]);
    await saveStarted;

    const clearing = manager.clear();
    await Promise.resolve();
    expect(storage.clearCalls).toBe(0);
    releaseSave();
    await clearing;

    expect(storage.clearCalls).toBe(1);
    expect(storage.saved).toBeNull();
    manager.dispose();
  });

  it("keeps saving the resume position while playback goes on", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await vi.advanceTimersByTimeAsync(0);

    // The player reports its position twice a second.
    for (let tick = 1; tick <= 24; tick++) {
      player.start({ key: "a", track: song("a") }, 1 + tick, tick / 2);
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(storage.saved?.resumePositionSeconds).toBeGreaterThanOrEqual(10);
    manager.dispose();
  });
  it("cancels a pending telemetry save when clearing", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const save = vi.spyOn(storage, "save");
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await vi.advanceTimersByTimeAsync(0);
    player.start({ key: "a", track: song("a") }, 2, 10);
    await vi.advanceTimersByTimeAsync(0);
    await manager.clear();
    const savesAfterClear = save.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(save).toHaveBeenCalledTimes(savesAfterClear);
    expect(storage.saved).toBeNull();
    manager.dispose();
  });

  it("follows mpv into a track that is loading or has failed, so Next and Previous step from it", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c", "d", "e"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await flush();

    // "a" ended and mpv went on to "b", which has not started.
    player.load(occurrence("b"), 2);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "b", origin: "source" }, source: { window: { cursor: { key: "b", offset: 1 }, previous: [{ key: "a" }] } } });
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("c");

    // "c" ended and mpv went on to "d", where playback broke off for a reason that is not the track's.
    player.start(occurrence("c"), 3, 30);
    player.fail(occurrence("d"), 4, false);
    await flush();
    expect(manager.store.state.nowPlaying?.key).toBe("d");
    expect(selections(player)).toEqual(["a", "c"]);
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("e");
    player.fail(occurrence("e"), 5, false);
    await flush();
    await manager.previous();
    expect(player.applies.at(-1)?.select?.key).toBe("d");
    manager.dispose();
  });

  it("moves past a track that cannot be played, as Next would, and keeps playback paused when it was", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c", "d"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await flush();
    await manager.enqueue([song("x")]);
    const x = manager.store.state.userQueue[0]!;

    // mpv went on to the queued track, which failed a second time.
    player.fail(x, 2);
    await flush();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: "b", play: true }, items: [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "b", origin: "source" }, userQueue: [] });

    player.report(occurrence("b"), 3, { status: "paused", paused: true });
    await manager.next();
    player.fail(occurrence("c"), 4);
    await flush();
    expect(player.applies.at(-1)?.select).toMatchObject({ key: "d", play: false });
    manager.dispose();
  });

  it("stays on a failure after three unplayable tracks in a row, and when the track is not the cause", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }), storage: new MemoryStorage() });
    let sequence = 0;
    const fail = async (key: string, trackFailed = true) => {
      player.fail(occurrence(key), ++sequence, trackFailed);
      await flush();
    };

    await manager.playSource(album, "a");
    await fail("a", false);
    expect(selections(player)).toEqual(["a"]);

    await fail("a");
    await fail("b");
    await fail("c");
    expect(selections(player)).toEqual(["a", "b", "c", "d"]);
    await fail("d");
    expect(selections(player)).toEqual(["a", "b", "c", "d"]);
    expect(manager.store.state.nowPlaying?.key).toBe("d");

    // The user's own step lets the queue move on again, and so does a track that plays.
    await manager.next();
    await fail("e");
    await fail("f");
    player.start(occurrence("g"), ++sequence);
    await flush();
    await fail("h");
    await fail("i");
    expect(selections(player)).toEqual(["a", "b", "c", "d", "e", "f", "g", "i", "j"]);
    manager.dispose();
  });

  it("stays on a track that fails after it has played, or long after it was started: the server is likelier the cause", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1, 1800);
    await vi.advanceTimersByTimeAsync(0);

    // The stream breaks half an hour in.
    player.fail(occurrence("a"), 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(selections(player)).toEqual(["a"]);
    expect(manager.store.state.nowPlaying?.key).toBe("a");

    // A track that takes a minute to fail did not fail for being a bad file.
    await manager.next();
    await vi.advanceTimersByTimeAsync(60_000);
    player.fail(occurrence("b"), 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(selections(player)).toEqual(["a", "b"]);
    expect(manager.store.state.nowPlaying?.key).toBe("b");
    manager.dispose();
  });

  it("stays on the track restored at start when it cannot be loaded, with the place in it", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    storage.stored = {
      nowPlaying: { key: "a", origin: "source", track: song("a") },
      userQueue: [],
      source: { ref: album, cursor: { type: "item", key: "a", offset: 0 } },
      resumePositionSeconds: 2530,
    };
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c"] }), storage });
    await manager.restore();

    // The server is not there when the app starts.
    player.fail(occurrence("a"), 1);
    await flush();

    expect(selections(player)).toEqual(["a"]);
    expect(manager.store.state.nowPlaying?.key).toBe("a");
    // Nothing was selected after the restore, which asked for the track where it was left.
    expect(player.applies.filter(({ select }) => select).map(({ select }) => select?.positionSeconds)).toEqual([2530]);
    manager.dispose();
  });

  it("passes an unplayable track the way the user was going, and marks it until it plays", async () => {
    const player = new FakePlayer();
    const marked: string[][] = [];
    const manager = new QueueManager({
      player,
      sources: new FakeSources({ album: ["a", "b", "c", "d"] }),
      storage: new MemoryStorage(),
      onUnplayable: (tracks) => marked.push(tracks.map(({ id, skipped }) => `${id}:${skipped ? "skipped" : "stayed"}`)),
    });
    await manager.playSource(album, "d");
    player.start(occurrence("d"), 1);
    await flush();

    // Previous lands on a track that cannot be played: the queue goes on backwards, not back to "d".
    await manager.previous();
    player.fail(occurrence("c"), 2);
    await flush();
    expect(selections(player)).toEqual(["d", "c", "b"]);
    expect(marked.at(-1)).toEqual(["c:skipped"]);

    // From a track that plays, playback goes forwards again: the next failure is passed that way.
    player.start(occurrence("b"), 3);
    await flush();
    player.fail(occurrence("c"), 4);
    await flush();
    expect(selections(player)).toEqual(["d", "c", "b", "d"]);

    // At the start of the queue there is nothing before it to go on to: it stays, and is marked as such.
    player.start(occurrence("b"), 5);
    await flush();
    await manager.previous();
    player.fail(occurrence("a"), 6);
    await flush();
    expect(manager.store.state.nowPlaying?.key).toBe("a");
    expect(marked.at(-1)).toEqual(["c:skipped", "a:stayed"]);

    // A marked track that plays after all is no longer marked, and clearing the queue clears the rest.
    player.start(occurrence("a"), 7);
    await flush();
    expect(marked.at(-1)).toEqual(["c:skipped"]);
    await manager.clear();
    expect(marked.at(-1)).toEqual([]);
    manager.dispose();
  });

  it("stays on a failure at the end of the queue, also when a track is queued afterwards", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    player.fail(occurrence("b"), 2);
    await flush();
    expect(manager.store.state.nowPlaying?.key).toBe("b");

    await manager.enqueue([song("x")]);
    player.fail(occurrence("b"), 3);
    await flush();
    expect(selections(player)).toEqual(["a"]);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "b" }, userQueue: [{ track: { id: "x" } }] });

    await manager.next();
    expect(manager.store.state).toMatchObject({ nowPlaying: { track: { id: "x" }, origin: "user" }, userQueue: [] });
    manager.dispose();
  });

  it("keeps a loading track that a library change takes out of its source", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const sources = new FakeSources({ album: ["a", "b", "c"] });
    const manager = new QueueManager({ player, sources, storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await vi.advanceTimersByTimeAsync(0);

    await manager.next();
    sources.albums.album = ["a", "c"];
    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.store.state).toMatchObject({
      nowPlaying: { key: "b", origin: "source" },
      source: { window: { cursor: { type: "gap", offset: 1 }, previous: [{ key: "a" }], next: [{ key: "c" }] } },
    });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["a", "b", "c"]);

    player.start(occurrence("b"), 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.store.state.nowPlaying?.key).toBe("b");
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe("c");
    manager.dispose();
  });

  it("follows mpv into a track a library change has just taken out of the window", async () => {
    vi.useFakeTimers();
    const player = new FakePlayer();
    const sources = new FakeSources({ album: ["a", "b", "c"] });
    const manager = new QueueManager({ player, sources, storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await vi.advanceTimersByTimeAsync(0);
    sources.albums.album = ["a", "c"];
    sources.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(manager.store.state.source?.window.next.map(({ key }) => key)).toEqual(["c"]);

    // mpv had started "b" before it heard of the change.
    player.load(occurrence("b"), 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.store.state).toMatchObject({
      nowPlaying: { key: "b", origin: "source" },
      source: { window: { cursor: { type: "gap", offset: 1 }, previous: [{ key: "a" }], next: [{ key: "c" }] } },
    });
    expect(player.applies.at(-1)).toMatchObject({ items: [{ key: "a" }, { key: "b" }, { key: "c" }] });
    expect(player.applies.at(-1)?.select).toBeUndefined();
    await manager.previous();
    expect(player.applies.at(-1)?.select?.key).toBe("a");
    manager.dispose();
  });

  it("is on a selection the player holds although it refused it", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });
    player.applyError = new Error("mpv is missing");
    player.holdsWhatItRefuses = true;

    await expect(manager.playSource(album, "a")).rejects.toThrow("mpv is missing");
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a", origin: "source" }, source: { ref: album, window: { next: [{ key: "c" }] } } });

    player.holdsWhatItRefuses = false;
    await expect(manager.next()).rejects.toThrow("mpv is missing");
    expect(manager.store.state.nowPlaying?.key).toBe("a");
    manager.dispose();
  });

  it("plays an occurrence of the queue, which the queued tracks passed over leave", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: new FakeSources({ album: ["a", "b", "c"] }), storage: new MemoryStorage() });
    await manager.playSource(album, "a");
    player.report(occurrence("a"), 1, { status: "paused", paused: true });
    await flush();
    await manager.enqueue([song("x"), song("y"), song("z")]);
    const [, y, z] = manager.store.state.userQueue;

    await manager.select(y!.key);
    expect(player.applies.at(-1)).toMatchObject({ select: { key: y!.key, play: true }, items: [{ key: "a" }, { key: y!.key }, { key: z!.key }, { key: "b" }, { key: "c" }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: y!.key, origin: "user" }, userQueue: [{ key: z!.key }], source: { window: { cursor: { key: "a" } } } });

    await manager.select("c");
    expect(player.applies.at(-1)).toMatchObject({ select: { key: "c" }, items: [{ key: "a" }, { key: "b" }, { key: "c" }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "c", origin: "source" }, userQueue: [], source: { window: { cursor: { key: "c", offset: 2 } } } });

    await expect(manager.select("gone")).rejects.toThrow("not in the queue");
    expect(manager.store.state.nowPlaying?.key).toBe("c");
    manager.dispose();
  });

  it("clears the queue and what is stored of it even when the player refuses to stop", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.playSource(album, "a");
    player.start(occurrence("a"), 1);
    await manager.enqueue([song("queued")]);
    player.stopError = new Error("the player is busy");

    await expect(manager.clear()).rejects.toThrow("the player is busy");
    expect(manager.store.state).toEqual({ nowPlaying: null, userQueue: [], source: null });
    expect(storage.saved).toBeNull();

    // The player plays on. It is no longer this queue's, so nothing of it comes back.
    player.start(occurrence("a"), 2, 10);
    player.load(occurrence("c"), 3);
    await flush();
    expect(manager.store.state).toEqual({ nowPlaying: null, userQueue: [], source: null });
    expect(storage.saved).toBeNull();
    manager.dispose();
  });
});
