import { describe, expect, it } from "vitest";

import type { CreatePlaylistArgs, DeletePlaylistArgs, GetPlaylistArgs, PlaylistWithSongs, UpdatePlaylistArgs } from "@muswag/subsonic-api";
import { createPlaylist, createPlaylistSyncManager, logout, renamePlaylist } from "@muswag/shared";
import { createInMemoryDb } from "../navidrome-testkit.js";

type FakePlaylist = {
  id: string;
  name: string;
  comment: string;
  public: boolean;
  songIds: string[];
};

function apiPlaylist(playlist: FakePlaylist): PlaylistWithSongs {
  return {
    ...playlist,
    songCount: playlist.songIds.length,
    duration: playlist.songIds.length * 60,
    created: "2026-07-10T00:00:00.000Z",
    changed: "2026-07-10T00:00:00.000Z",
    entry: playlist.songIds.map((id) => ({ id, title: id, isDir: false })),
  };
}

class FakePlaylistApi {
  readonly playlists = new Map<string, FakePlaylist>();
  createError: Error | undefined;
  getPlaylistStarted: (() => void) | undefined;
  getPlaylistGate: Promise<void> | undefined;
  nextId = 1;

  async getPlaylists() {
    return {
      status: "ok",
      version: "1.16.1",
      playlists: {
        playlist: [...this.playlists.values()].map((playlist) => apiPlaylist(playlist)),
      },
    };
  }

  async getPlaylist({ id }: GetPlaylistArgs) {
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
