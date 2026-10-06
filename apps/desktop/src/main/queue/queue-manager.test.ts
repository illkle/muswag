import { afterEach, describe, expect, it, vi } from "vitest";

import { songRow, type PlaybackItem, type Song } from "@muswag/model";
import type { QueueManagerState, SourceItem } from "#shared/queue-state";
import type { QueueSource, QueueSourceFactory } from "./source/types";
import type { QueueStorage, StoredQueue } from "./db-queue-storage";
import type { ApplyQueueInput, PlayerRuntimeState, QueuePlayerPort } from "./player-port";
import { QueueManager } from "./queue-manager";

const song = (id: string): Song => songRow({ id, title: id });
const sourceItem = (key: string, offset: number): SourceItem => ({ key, offset, track: song(key) });

class FakePlayer implements QueuePlayerPort {
  state: PlayerRuntimeState = { sequence: 0, current: null, status: "idle", positionSeconds: 0, paused: false };
  listeners = new Set<(state: PlayerRuntimeState) => void>();
  applies: ApplyQueueInput[] = [];
  applyError: Error | null = null;
  restarts = 0;

  async applyQueue(input: ApplyQueueInput): Promise<void> {
    this.applies.push(structuredClone(input));
    if (this.applyError) throw this.applyError;
  }
  async restartCurrent(): Promise<void> {
    this.restarts += 1;
  }
  async stop(): Promise<void> {}
  async getState(): Promise<PlayerRuntimeState> {
    return this.state;
  }
  subscribe(listener: (state: PlayerRuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(item: PlaybackItem, sequence: number, positionSeconds = 0): void {
    this.state = { ...this.state, sequence, current: structuredClone(item), positionSeconds, status: "playing" };
    for (const listener of this.listeners) listener(this.state);
  }
  /** The player has selected `item`, which has not started yet. */
  load(item: PlaybackItem, sequence: number): void {
    this.state = { ...this.state, sequence, current: structuredClone(item), status: "loading" };
    for (const listener of this.listeners) listener(this.state);
  }
}

class FakeSource implements QueueSource {
  readonly ref = { type: "album" as const, albumId: "album" };
  constructor(readonly items = [sourceItem("a", 0), sourceItem("c", 1)]) {}
  async read({ start, end }: { start: number; end: number; signal: AbortSignal }) {
    return { revision: "1", items: this.items.filter(({ offset }) => offset >= start && offset < end), nextOffset: Math.max(start, Math.min(end, this.items.length)), isEnd: end >= this.items.length };
  }
  async locate({ key }: { key: string; signal: AbortSignal }) {
    const item = this.items.find((candidate) => candidate.key === key);
    return item ? { revision: "1", offset: item.offset } : null;
  }
  subscribe(): () => void {
    return () => undefined;
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

const factory: QueueSourceFactory = { open: () => new FakeSource() };

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

    await expect(manager.restore()).resolves.toBe(true);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a", track: { id: "embedded-deleted-library-row" } }, source: { window: { cursor: { key: "a", offset: 0 } } } });
    expect(player.applies.at(-1)?.select).toEqual({ key: "a", play: false, positionSeconds: 42 });
    expect(player.applies.at(-1)?.items.map(({ key }) => key)).toEqual(["a", "user:saved", "c"]);
    manager.dispose();
  });

  it("restores a queue with nothing playing without loading it, and keeps a queue mpv cannot load", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    storage.stored = { nowPlaying: null, userQueue: [{ key: "user:saved", track: song("queued") }], source: null, resumePositionSeconds: 0 };
    const idle = new QueueManager({ player, sources: factory, storage });
    await expect(idle.restore()).resolves.toBe(true);
    expect(player.applies).toEqual([]);
    expect(idle.store.state.userQueue.map(({ key }) => key)).toEqual(["user:saved"]);
    idle.dispose();

    storage.stored = { ...storage.stored, nowPlaying: { key: "user:now", origin: "user", track: song("now") } };
    player.applyError = new Error("mpv is missing");
    const broken = new QueueManager({ player, sources: factory, storage });
    await expect(broken.restore()).resolves.toBe(true);
    expect(broken.store.state).toMatchObject({ nowPlaying: { key: "user:now" }, userQueue: [{ key: "user:saved" }] });
    broken.dispose();
  });

  it("commits only correlated starts and keeps manual items out of source history", async () => {
    const player = new FakePlayer();
    const manager = new QueueManager({ player, sources: factory, storage: new MemoryStorage() });

    await manager.playSource({ type: "album", albumId: "album" }, "a");
    expect(manager.store.state.nowPlaying).toBeNull();
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    expect(manager.store.state.nowPlaying).toMatchObject({ key: "a", origin: "source" });

    await manager.enqueue([song("b")]);
    const user = manager.store.state.userQueue[0]!;
    await manager.next();
    expect(manager.store.state.userQueue).toHaveLength(1);
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
    const source = new FakeSource(["a", "b", "c"].map((key, offset) => sourceItem(key, offset)));
    const manager = new QueueManager({ player, sources: { open: () => source }, storage: new MemoryStorage() });
    await manager.playSource(source.ref, "a");
    player.start({ key: "a", track: song("a") }, 1, 30);
    await flush();
    await manager.enqueue([song("x"), song("y")]);
    const [x, y] = manager.store.state.userQueue;

    await manager.next();
    player.load(x!, 2);
    await flush();
    await manager.next();
    expect(player.applies.at(-1)?.select?.key).toBe(y!.key);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a" }, userQueue: [{ key: y!.key }] });
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
    expect(player.applies.filter(({ select }) => select).map(({ select }) => select?.key)).toEqual(["a", x!.key, y!.key, "b", "a", "b", "c"]);

    player.start({ key: "c", track: song("c") }, 3, 30);
    await flush();
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "c", origin: "source" }, source: { window: { cursor: { key: "c", offset: 2 } } } });
    await manager.previous();
    expect(player.restarts).toBe(1);
    manager.dispose();
  });

  it("steps through a source that is still starting, and plays from it", async () => {
    const player = new FakePlayer();
    const second = new FakeSource(["p", "q"].map((key, offset) => sourceItem(key, offset)));
    const sources: QueueSourceFactory = { open: (ref) => (ref.type === "album" && ref.albumId === "second" ? second : new FakeSource()) };
    const manager = new QueueManager({ player, sources, storage: new MemoryStorage() });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1);
    await flush();
    await manager.enqueue([song("x")]);
    const x = manager.store.state.userQueue[0]!;

    await manager.playSource({ type: "album", albumId: "second" }, "p");
    await manager.next();
    expect(player.applies.at(-1)).toMatchObject({ select: { key: x.key }, items: [{ key: "p" }, { key: x.key }, { key: "q" }] });
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a" }, source: { ref: { albumId: "album" } } });
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

  it("preserves pending users across source replacement and clearQueued leaves a playing user alone", async () => {
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
    await manager.clearQueued();
    expect(manager.store.state.nowPlaying?.key).toBe(queued.key);
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
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    const manager = new QueueManager({ player, sources: factory, storage });
    await manager.playSource({ type: "album", albumId: "album" }, "a");
    player.start({ key: "a", track: song("a") }, 1, 7);
    await flush();
    expect(storage.saved).toMatchObject({ state: { nowPlaying: { key: "a" } }, resumePositionSeconds: 7 });

    await manager.enqueue([song("queued")]);
    await flush();
    expect(storage.saved?.state.userQueue.map(({ track }) => track.id)).toEqual(["queued"]);
    expect(storage.saved?.resumePositionSeconds).toBe(7);
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
    await expect(manager.clearQueued()).rejects.toThrow("mpv rejected queue");

    expect(manager.store.state.userQueue).toEqual(before);
    expect(storage.saved?.state.userQueue).toEqual(before);
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
});
