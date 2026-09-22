import { describe, expect, it } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { Clock, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";

import BetterSqlite3 from "better-sqlite3-test"; // eslint-disable-line
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import type { CreatePlaylistArgs, DeletePlaylistArgs, GetPlaylistArgs, PlaylistWithSongs, UpdatePlaylistArgs } from "../api/subsonic-api-schema.js";
import { addPlaylistEntry, createPlaylist, deletePlaylist, PlaylistSyncManager, PlaylistSyncManagerLive, type PlaylistSyncManagerOptions, removePlaylistEntry, renamePlaylist } from "./index.js";
import SubsonicAPI, { type SubsonicApiService } from "../api/subsonic-api.js";
import { createMuswagDb, MuswagDatabase, type MuswagDb } from "../db/database.js";
import { createInMemoryDb } from "../test/database.js";

type FakePlaylist = {
  id: string;
  name: string;
  comment: string;
  public: boolean;
  songIds: string[];
  owner?: string;
  changed?: string;
};

function apiPlaylist(playlist: FakePlaylist): PlaylistWithSongs {
  const { changed, ...rest } = playlist;
  return {
    ...rest,
    songCount: playlist.songIds.length,
    duration: playlist.songIds.length * 60,
    created: "2026-07-10T00:00:00.000Z",
    changed: changed ?? "2026-07-10T00:00:00.000Z",
    entry: playlist.songIds.map((id) => ({ id, title: id, isDir: false })),
  };
}

class FakePlaylistApi {
  readonly username = "alice";
  readonly playlists = new Map<string, FakePlaylist>();
  readonly getPlaylistCalls: string[] = [];
  readonly updatePlaylistCalls: UpdatePlaylistArgs[] = [];
  getPlaylistsCalls = 0;
  readonly getPlaylistsCallTimes: number[] = [];
  createError: Error | undefined;
  createPlaylistStarted: (() => void) | undefined;
  createPlaylistGate: Promise<void> | undefined;
  listError: Error | undefined;
  getPlaylistStarted: (() => void) | undefined;
  getPlaylistGate: Promise<void> | undefined;
  getPlaylistHook: ((id: string, callNumber: number) => void) | undefined;
  nextId = 1;

  getPlaylists = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      this.getPlaylistsCalls += 1;
      this.getPlaylistsCallTimes.push(now);
      if (this.listError) return Effect.fail(this.listError);
      return Effect.succeed({
        status: "ok" as const,
        version: "1.16.1",
        playlists: { playlist: [...this.playlists.values()].map((playlist) => apiPlaylist(playlist)) },
      });
    }),
  );

  getPlaylist({ id }: GetPlaylistArgs) {
    return Effect.promise(async () => {
      this.getPlaylistCalls.push(id);
      this.getPlaylistStarted?.();
      await this.getPlaylistGate;
      this.getPlaylistHook?.(id, this.getPlaylistCalls.length);
      const playlist = this.playlists.get(id);
      if (!playlist) throw new Error(`Missing playlist: ${id}`);
      return { status: "ok" as const, version: "1.16.1", playlist: apiPlaylist(playlist) };
    });
  }

  createPlaylist(args: CreatePlaylistArgs) {
    return Effect.promise(async () => {
      if (this.createError) throw this.createError;
      this.createPlaylistStarted?.();
      await this.createPlaylistGate;
      const id = `server-${this.nextId++}`;
      const playlist = {
        id,
        name: args.name ?? "Untitled",
        comment: "",
        public: false,
        songIds: args.songId ?? [],
      };
      this.playlists.set(id, playlist);
      return { status: "ok" as const, version: "1.16.1", playlist: apiPlaylist(playlist) };
    });
  }

  updatePlaylist(args: UpdatePlaylistArgs) {
    return Effect.sync(() => {
      this.updatePlaylistCalls.push(args);
      const playlist = this.playlists.get(args.playlistId);
      if (!playlist) throw new Error(`Missing playlist: ${args.playlistId}`);
      for (const index of args.songIndexToRemove ?? []) {
        playlist.songIds.splice(index, 1);
      }
      playlist.songIds.push(...(args.songIdToAdd ?? []));
      if (args.name !== undefined) playlist.name = args.name;
      if (args.comment !== undefined) playlist.comment = args.comment;
      if (args.public !== undefined) playlist.public = args.public;
      return { status: "ok" as const, version: "1.16.1" };
    });
  }

  deletePlaylist({ id }: DeletePlaylistArgs) {
    return Effect.sync(() => {
      this.playlists.delete(id);
      return { status: "ok" as const, version: "1.16.1" };
    });
  }
}

function insertCredentials(db: ReturnType<typeof createInMemoryDb>) {
  db.userCredentials.insert({ id: 1, url: "https://music.example", username: "alice", password: "secret" });
}

function managerLayer(db: MuswagDb, api: FakePlaylistApi, options: PlaylistSyncManagerOptions = {}) {
  return PlaylistSyncManagerLive({
    intervalMs: 0,
    debounceMs: 10_000,
    retryMs: 10_000,
    ...options,
  }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(MuswagDatabase, db), Layer.succeed(SubsonicAPI, api as unknown as SubsonicApiService))));
}

function createManager(db: MuswagDb, api: FakePlaylistApi, options: PlaylistSyncManagerOptions = {}) {
  const layer = managerLayer(db, api, options);
  const runtime = ManagedRuntime.make(layer);
  const service = runtime.runSync(PlaylistSyncManager);

  return {
    getStatus: () => runtime.runSync(service.getStatus),
    subscribe: (listener: Parameters<typeof service.subscribe>[0]) => runtime.runSync(service.subscribe(listener)),
    sync: () => runtime.runPromise(service.sync),
    pause: () => runtime.runPromise(service.pause),
    resume: () => runtime.runPromise(service.resume),
    cancel: () => runtime.runPromise(service.cancel),
    destroy: () => runtime.dispose(),
  };
}

async function waitForCompletedSync(manager: ReturnType<typeof createManager>): Promise<void> {
  if (manager.getStatus().lastSyncedAt) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for playlist sync: ${JSON.stringify(manager.getStatus())}`));
    }, 1_000);
    const unsubscribe = manager.subscribe((status) => {
      if (!status.lastSyncedAt) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

/** The status is published before the pass chain finishes unwinding; this waits for the rest. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Resolves once a pass that started after this call has finished, successfully or not. */
function waitForSyncCycle(manager: ReturnType<typeof createManager>, timeoutMs = 1_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sawSyncing = false;
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for a playlist sync cycle: ${JSON.stringify(manager.getStatus())}`));
    }, timeoutMs);
    const unsubscribe = manager.subscribe((status) => {
      if (status.state === "syncing") {
        sawSyncing = true;
        return;
      }
      if (!sawSyncing) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

describe("playlist sync manager", () => {
  it("pulls full remote state on startup", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", {
      id: "server-1",
      name: "Remote mix",
      comment: "",
      public: false,
      songIds: ["song-a", "song-b"],
    });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);

    expect(db.playlists.get("server-1")?.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-b"]);
    expect(db.playlists.get("server-1")?.base).toEqual(db.playlists.get("server-1")?.local);
    manager.destroy();
  });

  it("pushes and verifies an offline create", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    insertCredentials(db);
    const playlist = createPlaylist(db, { name: "Offline", songIds: ["song-a", "song-a"] });
    const manager = createManager(db, api);

    await manager.sync();

    expect([...api.playlists.values()][0]).toMatchObject({ name: "Offline", songIds: ["song-a", "song-a"] });
    expect(db.playlists.get(playlist.id)?.serverId).toBe("server-1");
    expect(db.playlists.get(playlist.id)?.base).toEqual(db.playlists.get(playlist.id)?.local);
    manager.destroy();
  });

  it("reads local state after the remote request finishes", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", {
      id: "server-1",
      name: "Original",
      comment: "",
      public: false,
      songIds: [],
    });
    const state = { name: "Original", comment: "", public: false, readonly: false, entries: [] };
    db.playlists.insert({ id: "server-1", serverId: "server-1", base: state, local: state, revision: 0 });
    insertCredentials(db);

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.getPlaylistStarted = started;
    api.getPlaylistGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createManager(db, api);

    const syncing = manager.sync();
    await startedPromise;
    renamePlaylist(db, "server-1", "Edited while fetching");
    release();
    await syncing;

    expect(api.playlists.get("server-1")?.name).toBe("Edited while fetching");
    manager.destroy();
  });

  it("keeps a failed create pending for retry", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.createError = new Error("create failed");
    insertCredentials(db);
    const playlist = createPlaylist(db, { name: "Still local" });
    const manager = createManager(db, api);

    await manager.sync();

    expect(db.playlists.get(playlist.id)).toMatchObject({ serverId: null, base: null });
    expect(db.playlists.get(playlist.id)?.local?.name).toBe("Still local");
    expect(manager.getStatus().error).toBe("create failed");
    manager.destroy();
  });

  it("deletes a playlist that is removed while its create request is in flight", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    insertCredentials(db);
    const manager = createManager(db, api);
    await waitForCompletedSync(manager);
    await settle();

    let releaseCreate!: () => void;
    let createStarted!: () => void;
    const createStartedPromise = new Promise<void>((resolve) => {
      createStarted = resolve;
    });
    api.createPlaylistStarted = createStarted;
    api.createPlaylistGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });

    const playlist = createPlaylist(db, { name: "Delete me", songIds: ["song-a"] });
    const firstPass = manager.sync();
    await createStartedPromise;
    deletePlaylist(db, playlist.id);
    releaseCreate();
    await firstPass;
    await settle();
    await manager.sync();

    expect(api.playlists.size).toBe(0);
    expect(db.playlists.get(playlist.id)).toBeUndefined();
    manager.destroy();
  });

  it("does not rewrite entries for a metadata-only edit", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a"] });
    insertCredentials(db);
    const manager = createManager(db, api);
    await waitForCompletedSync(manager);
    await settle();
    api.updatePlaylistCalls.length = 0;

    renamePlaylist(db, "server-1", "Renamed");
    await manager.sync();

    expect(api.updatePlaylistCalls).toEqual([
      expect.objectContaining({
        playlistId: "server-1",
        name: "Renamed",
      }),
    ]);
    expect(api.updatePlaylistCalls[0]?.songIndexToRemove).toBeUndefined();
    expect(api.updatePlaylistCalls[0]?.songIdToAdd).toBeUndefined();
    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-a"]);
    manager.destroy();
  });

  it("re-merges instead of replacing from a stale remote snapshot", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a"] });
    insertCredentials(db);
    const manager = createManager(db, api);
    await waitForCompletedSync(manager);
    await settle();
    api.getPlaylistCalls.length = 0;
    api.updatePlaylistCalls.length = 0;

    addPlaylistEntry(db, "server-1", "song-local");
    api.getPlaylistHook = (id, callNumber) => {
      if (id === "server-1" && callNumber === 2) {
        api.playlists.get(id)!.songIds.push("song-remote");
        api.getPlaylistHook = undefined;
      }
    };

    await manager.sync();
    await settle();
    await manager.sync();

    expect(api.updatePlaylistCalls).toHaveLength(1);
    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-a", "song-remote", "song-local"]);
    expect(db.playlists.get("server-1")?.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-remote", "song-local"]);
    manager.destroy();
  });

  it("reuses unchanged playlists instead of refetching them on an edit-triggered pass", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "One", comment: "", public: false, songIds: ["song-a"] });
    api.playlists.set("server-2", { id: "server-2", name: "Two", comment: "", public: false, songIds: ["song-b"] });
    insertCredentials(db);
    const manager = createManager(db, api, {
      debounceMs: 5,
    });

    await waitForCompletedSync(manager);
    expect(api.getPlaylistCalls).toEqual(["server-1", "server-2"]);
    api.getPlaylistCalls.length = 0;

    const cycle = waitForSyncCycle(manager);
    renamePlaylist(db, "server-1", "One edited");
    await cycle;

    expect(api.getPlaylistCalls).toContain("server-1");
    expect(api.getPlaylistCalls).not.toContain("server-2");
    expect(api.playlists.get("server-1")?.name).toBe("One edited");
    manager.destroy();
  });

  it("refetches a playlist whose changed timestamp moved", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "One", comment: "", public: false, songIds: ["song-a"] });
    api.playlists.set("server-2", { id: "server-2", name: "Two", comment: "", public: false, songIds: ["song-b"] });
    insertCredentials(db);
    const manager = createManager(db, api, {
      debounceMs: 5,
    });

    await waitForCompletedSync(manager);
    api.getPlaylistCalls.length = 0;

    const remote = api.playlists.get("server-2")!;
    remote.name = "Two renamed elsewhere";
    remote.changed = "2026-07-11T00:00:00.000Z";

    const cycle = waitForSyncCycle(manager);
    renamePlaylist(db, "server-1", "One edited");
    await cycle;

    expect(api.getPlaylistCalls).toContain("server-2");
    expect(db.playlists.get("server-2")?.local?.name).toBe("Two renamed elsewhere");
    manager.destroy();
  });

  it("refetches everything on a manual sync", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "One", comment: "", public: false, songIds: ["song-a"] });
    api.playlists.set("server-2", { id: "server-2", name: "Two", comment: "", public: false, songIds: ["song-b"] });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);
    await settle();
    api.getPlaylistCalls.length = 0;

    await manager.sync();

    expect(api.getPlaylistCalls).toEqual(["server-1", "server-2"]);
    manager.destroy();
  });

  it("serializes concurrent manual syncs", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "One", comment: "", public: false, songIds: [] });
    insertCredentials(db);
    const manager = createManager(db, api);
    await waitForCompletedSync(manager);

    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    api.getPlaylistStarted = started;
    api.getPlaylistGate = new Promise<void>((resolve) => (release = resolve));
    const previousCalls = api.getPlaylistCalls.length;

    const first = manager.sync();
    await startedPromise;
    const second = manager.sync();
    await settle();
    expect(api.getPlaylistCalls).toHaveLength(previousCalls + 1);

    release();
    await Promise.all([first, second]);
    expect(api.getPlaylistCalls).toHaveLength(previousCalls + 2);
    manager.destroy();
  });

  it("treats playlists owned by another user as read-only", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("mine", { id: "mine", name: "Mine", comment: "", public: false, songIds: [], owner: "Alice" });
    api.playlists.set("theirs", { id: "theirs", name: "Theirs", comment: "", public: true, songIds: [], owner: "bob" });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);

    expect(db.playlists.get("mine")?.local?.readonly).toBe(false);
    expect(db.playlists.get("theirs")?.local?.readonly).toBe(true);
    expect(() => renamePlaylist(db, "theirs", "Hijacked")).toThrow("Playlist is read-only");
    manager.destroy();
  });

  it("resolves sync() with the status of the pass", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    insertCredentials(db);
    const manager = createManager(db, api);

    const ok = await manager.sync();
    expect(ok.state).toBe("idle");
    expect(ok.error).toBeNull();
    expect(ok.lastSyncedAt).not.toBeNull();

    api.listError = new Error("server unreachable");
    const failed = await manager.sync();
    expect(failed.state).toBe("error");
    expect(failed.error).toBe("server unreachable");
    manager.destroy();
  });

  effectIt.effect("backs off between consecutive failures", () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.listError = new Error("offline");
    insertCredentials(db);

    return Effect.gen(function* () {
      const manager = yield* PlaylistSyncManager;
      yield* manager.sync;
      yield* TestClock.adjust(20_000);
      yield* TestClock.adjust(40_000);
      yield* TestClock.adjust(60_000);
      yield* Effect.yieldNow;

      const callTimes = [...new Set(api.getPlaylistsCallTimes)];
      expect(callTimes.slice(-4)).toEqual([0, 20_000, 60_000, 120_000]);
    }).pipe(Effect.provide(managerLayer(db, api, { retryMs: 20_000, maxRetryMs: 60_000 })));
  });

  it("does not drop unsynced playlists when the collection loads lazily", async () => {
    const sqlite = new BetterSqlite3(":memory:");
    const persistence = createNodeSQLitePersistence({ database: sqlite });

    const seed = createMuswagDb(persistence);
    await seed.playlists.preload();
    await seed.userCredentials.preload();
    seed.userCredentials.insert({ id: 1, url: "https://music.example", username: "alice", password: "secret" });
    const created = createPlaylist(seed, { name: "Written offline", songIds: ["song-a"] });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A fresh process starts syncing against a collection that has not read from disk yet.
    const cold = createMuswagDb(persistence);
    const api = new FakePlaylistApi();
    const manager = createManager(cold, api);

    await waitForCompletedSync(manager);

    expect([...api.playlists.values()].map(({ name }) => name)).toEqual(["Written offline"]);
    expect(cold.playlists.get(created.id)?.serverId).toBe("server-1");
    manager.destroy();
  });

  it("does not re-add an entry pushed to an already-synced playlist", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a"] });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);
    await settle();

    addPlaylistEntry(db, "server-1", "song-b");
    await manager.sync();
    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-a", "song-b"]);

    // The song used to come back as a remote addition on every verification pass, so the playlist
    // grew by one copy per sync.
    await manager.sync();
    await manager.sync();

    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-a", "song-b"]);
    expect(db.playlists.get("server-1")?.local?.entries.map(({ songId }) => songId)).toEqual(["song-a", "song-b"]);
    manager.destroy();
  });

  it("settles with nothing left to push after an edit", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a"] });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);
    await settle();

    addPlaylistEntry(db, "server-1", "song-b");
    await manager.sync();
    await settle();

    const record = db.playlists.get("server-1")!;
    expect(record.base).toEqual(record.local);
    // A converged pass must not leave another one queued.
    expect(manager.getStatus().state).toBe("idle");
    manager.destroy();
  });

  it("keeps duplicates the user added on purpose", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a"] });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);
    await settle();

    addPlaylistEntry(db, "server-1", "song-a");
    await manager.sync();
    await manager.sync();

    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-a", "song-a"]);
    manager.destroy();
  });

  it("pushes a removal without the entry reappearing", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "Mix", comment: "", public: false, songIds: ["song-a", "song-b"] });
    insertCredentials(db);
    const manager = createManager(db, api);

    await waitForCompletedSync(manager);
    await settle();

    const entries = db.playlists.get("server-1")!.local!.entries;
    removePlaylistEntry(db, "server-1", entries[0]!.id);
    await manager.sync();
    await manager.sync();

    expect(api.playlists.get("server-1")?.songIds).toEqual(["song-b"]);
    manager.destroy();
  });

  it("aborts an in-flight pass when its session scope closes", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", {
      id: "server-1",
      name: "Remote",
      comment: "",
      public: false,
      songIds: [],
    });
    insertCredentials(db);
    createPlaylist(db, { name: "Pending" });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.getPlaylistStarted = started;
    api.getPlaylistGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createManager(db, api);

    const syncing = manager.sync();
    await startedPromise;
    db.playlists.delete([...db.playlists.keys()]);
    const destroying = manager.destroy();
    release();
    await syncing.catch(() => undefined);
    await destroying;

    expect([...db.playlists.entries()]).toEqual([]);
  });
});
