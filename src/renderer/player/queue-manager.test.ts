import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlaybackItem, QueueManagerSnapshot, QueueStorage, Song } from "#core";
import type { ApplyMpvQueueInput, PlayerRuntimeState, QueuePlayerPort } from "#shared/player";
import { createDefaultPlayerRuntimeState } from "#shared/player";
import type { QueueSource, QueueSourceFactory, SourceItem } from "./source";
import { QueueManager } from "./queue-manager";

const song = (id: string): Song => ({ id, isDir: false, title: id });
const sourceItem = (key: string, offset: number): SourceItem => ({ key, offset, track: song(key) });

class FakePlayer implements QueuePlayerPort {
  state = createDefaultPlayerRuntimeState();
  listeners = new Set<(state: PlayerRuntimeState) => void>();
  applies: ApplyMpvQueueInput[] = [];
  applyError: Error | null = null;
  restarts = 0;

  async applyQueue(input: ApplyMpvQueueInput): Promise<void> {
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
}

class FakeSource implements QueueSource {
  readonly ref = { type: "album" as const, albumId: "album" };
  readonly items = [sourceItem("a", 0), sourceItem("c", 1)];
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
  snapshot: QueueManagerSnapshot | null = null;
  async load() {
    return this.snapshot;
  }
  async save(snapshot: QueueManagerSnapshot) {
    this.snapshot = structuredClone(snapshot);
  }
  async clear() {
    this.snapshot = null;
  }
}

const factory: QueueSourceFactory = { open: () => new FakeSource() };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("QueueManager", () => {
  afterEach(() => vi.useRealTimers());

  it("restores embedded snapshots, source cursor, pause intent, and position before publishing", async () => {
    const player = new FakePlayer();
    const storage = new MemoryStorage();
    storage.snapshot = {
      version: 1,
      savedAt: "2026-08-13T00:00:00.000Z",
      nowPlaying: { key: "a", origin: "source", track: song("embedded-deleted-library-row") },
      userQueue: [{ key: "user:saved", track: song("queued") }],
      source: { ref: { type: "album", albumId: "album" }, cursor: { type: "item", key: "a", offset: 0 } },
      playback: { paused: true, positionSeconds: 42 },
    };
    const manager = new QueueManager({ player, sources: factory, storage });

    await expect(manager.restore()).resolves.toBe(true);
    expect(manager.store.state).toMatchObject({ nowPlaying: { key: "a", track: { id: "embedded-deleted-library-row" } }, source: { window: { cursor: { key: "a", offset: 0 } } } });
    expect(player.applies.at(-1)?.select).toEqual({ key: "a", play: false, positionSeconds: 42 });
    expect(player.applies.at(-1)?.snapshot.items.map(({ key }) => key)).toEqual(["a", "user:saved", "c"]);
    manager.dispose();
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
    expect(storage.snapshot?.userQueue).toEqual(before);
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
      override async save(snapshot: QueueManagerSnapshot): Promise<void> {
        markSaveStarted();
        await saveGate;
        await super.save(snapshot);
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
    expect(storage.snapshot).toBeNull();
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
    expect(storage.snapshot).toBeNull();
    manager.dispose();
  });
});
