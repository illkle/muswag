import { describe, expect, it, vi } from "vitest";

import BetterSqlite3 from "better-sqlite3-test"; // eslint-disable-line
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import type { CreatePlaylistArgs, DeletePlaylistArgs, GetPlaylistArgs, PlaylistWithSongs, UpdatePlaylistArgs } from "@muswag/subsonic-api";
import { createMuswagDb, createPlaylist, createPlaylistSyncManager, logout, renamePlaylist } from "@muswag/shared";
import { createInMemoryDb } from "../navidrome-testkit.js";

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
  readonly playlists = new Map<string, FakePlaylist>();
  readonly getPlaylistCalls: string[] = [];
  createError: Error | undefined;
  listError: Error | undefined;
  getPlaylistStarted: (() => void) | undefined;
  getPlaylistGate: Promise<void> | undefined;
  nextId = 1;

  async getPlaylists() {
    if (this.listError) throw this.listError;
    return {
      status: "ok",
      version: "1.16.1",
      playlists: {
        playlist: [...this.playlists.values()].map((playlist) => apiPlaylist(playlist)),
      },
    };
  }

  async getPlaylist({ id }: GetPlaylistArgs) {
    this.getPlaylistCalls.push(id);
    this.getPlaylistStarted?.();
    await this.getPlaylistGate;
    const playlist = this.playlists.get(id);
    if (!playlist) throw new Error(`Missing playlist: ${id}`);
    return { status: "ok", version: "1.16.1", playlist: apiPlaylist(playlist) };
  }

  async createPlaylist(args: CreatePlaylistArgs) {
    if (this.createError) throw this.createError;
    const id = `server-${this.nextId++}`;
    const playlist = {
      id,
      name: args.name ?? "Untitled",
      comment: "",
      public: false,
      songIds: args.songId ?? [],
    };
    this.playlists.set(id, playlist);
    return { status: "ok", version: "1.16.1", playlist: apiPlaylist(playlist) };
  }

  async updatePlaylist(args: UpdatePlaylistArgs) {
    const playlist = this.playlists.get(args.playlistId);
    if (!playlist) throw new Error(`Missing playlist: ${args.playlistId}`);
    for (const index of args.songIndexToRemove ?? []) {
      playlist.songIds.splice(index, 1);
    }
    playlist.songIds.push(...(args.songIdToAdd ?? []));
    if (args.name !== undefined) playlist.name = args.name;
    if (args.comment !== undefined) playlist.comment = args.comment;
    if (args.public !== undefined) playlist.public = args.public;
    return { status: "ok", version: "1.16.1" };
  }

  async deletePlaylist({ id }: DeletePlaylistArgs) {
    this.playlists.delete(id);
    return { status: "ok", version: "1.16.1" };
  }
}

function insertCredentials(db: ReturnType<typeof createInMemoryDb>) {
  db.userCredentials.insert({ id: 1, url: "https://music.example", username: "alice", password: "secret" });
}

function createManager(db: ReturnType<typeof createInMemoryDb>, api: FakePlaylistApi) {
  return createPlaylistSyncManager(db, {
    intervalMs: 0,
    debounceMs: 10_000,
    retryMs: 10_000,
    apiFactory: () => api as never,
  });
}

async function waitForCompletedSync(manager: ReturnType<typeof createPlaylistSyncManager>): Promise<void> {
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
function waitForSyncCycle(manager: ReturnType<typeof createPlaylistSyncManager>, timeoutMs = 1_000): Promise<void> {
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

  it("reuses unchanged playlists instead of refetching them on an edit-triggered pass", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.playlists.set("server-1", { id: "server-1", name: "One", comment: "", public: false, songIds: ["song-a"] });
    api.playlists.set("server-2", { id: "server-2", name: "Two", comment: "", public: false, songIds: ["song-b"] });
    insertCredentials(db);
    const manager = createPlaylistSyncManager(db, {
      intervalMs: 0,
      debounceMs: 5,
      retryMs: 10_000,
      apiFactory: () => api as never,
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
    const manager = createPlaylistSyncManager(db, {
      intervalMs: 0,
      debounceMs: 5,
      retryMs: 10_000,
      apiFactory: () => api as never,
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

  it("backs off between consecutive failures", async () => {
    const db = createInMemoryDb();
    const api = new FakePlaylistApi();
    api.listError = new Error("offline");
    insertCredentials(db);

    // Retry delays sit above every other timer in play, so the filter below can only see retries.
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: never, ms?: number, ...rest: never[]) => {
      if (typeof ms === "number" && ms >= 20_000) delays.push(ms);
      return realSetTimeout(handler, ms, ...rest);
    }) as never);

    const manager = createPlaylistSyncManager(db, {
      intervalMs: 0,
      debounceMs: 10_000,
      retryMs: 20_000,
      maxRetryMs: 60_000,
      apiFactory: () => api as never,
    });

    await waitForSyncCycle(manager);
    await settle();
    await manager.sync();
    await manager.sync();
    await manager.sync();

    manager.destroy();
    spy.mockRestore();

    const progression = delays.filter((ms, index) => index === 0 || ms !== delays[index - 1]);
    expect(progression).toEqual([20_000, 40_000, 60_000]);
    expect(Math.max(...delays)).toBe(60_000);
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
    const manager = createPlaylistSyncManager(cold, {
      intervalMs: 0,
      debounceMs: 10_000,
      retryMs: 10_000,
      apiFactory: () => api as never,
    });

    await waitForCompletedSync(manager);

    expect([...api.playlists.values()].map(({ name }) => name)).toEqual(["Written offline"]);
    expect(cold.playlists.get(created.id)?.serverId).toBe("server-1");
    manager.destroy();
  });

  it("aborts an in-flight pass and clears local state when credentials are removed", async () => {
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
    await logout(db);
    release();
    await syncing;

    expect([...db.playlists.entries()]).toEqual([]);
    expect(db.userCredentials.get(1)).toBeUndefined();
    expect(manager.getStatus().state).toBe("idle");
    expect(manager.getStatus().lastSyncedAt).toBeNull();
    manager.destroy();
  });
});
