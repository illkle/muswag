import { describe, expect, it } from "@effect/vitest";
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { Effect, Layer } from "effect";

import SubsonicAPI, { type SubsonicApiService } from "./api/subsonic-api.js";
import type { AlbumID3, AlbumWithSongsID3, Child, IndexArtist, PlaylistWithSongs } from "./api/subsonic-api-schema.js";
import { MuswagDatabase, type MuswagDb } from "./db/database.js";
import type { SyncState } from "./db/types.js";
import SyncManager from "./syncEffect.js";

let collectionId = 0;

const album = (id: string, overrides: Partial<AlbumID3> = {}): AlbumID3 => ({
  id,
  name: `Album ${id}`,
  artist: "Artist",
  created: "2026-01-01T00:00:00Z",
  duration: 120,
  songCount: 1,
  ...overrides,
});

const song = (id: string, albumId: string, overrides: Partial<Child> = {}): Child => ({
  id,
  albumId,
  title: `Song ${id}`,
  isDir: false,
  ...overrides,
});

const playlist = (id: string, entry: Child[]): PlaylistWithSongs => ({
  id,
  name: `Playlist ${id}`,
  songCount: entry.length,
  duration: 120,
  created: "2026-01-01T00:00:00Z",
  changed: "2026-01-01T00:00:00Z",
  entry,
});

function localCollection<T extends object, TKey extends string | number>(name: string, initialData: T[], getKey: (item: T) => TKey) {
  collectionId += 1;
  return createCollection(
    localOnlyCollectionOptions<T, TKey>({
      id: `${name}-${collectionId}`,
      initialData,
      getKey,
    }),
  );
}

function makeDatabase({
  albums = [],
  artists = [],
  songs = [],
  syncState = [],
}: {
  albums?: AlbumID3[];
  artists?: IndexArtist[];
  songs?: Child[];
  syncState?: SyncState[];
} = {}): MuswagDb {
  return {
    albums: localCollection("albums", albums, ({ id }) => id),
    artists: localCollection("artists", artists, ({ id }) => id),
    songs: localCollection("songs", songs, ({ id }) => id),
    syncState: localCollection("sync-state", syncState, ({ id }) => id),
  } as unknown as MuswagDb;
}

const unexpected = (method: string): Effect.Effect<never> => Effect.die(new Error(`Unexpected ${method} call`));

function makeApi(overrides: Partial<SubsonicApiService>): SubsonicApiService {
  return {
    baseUrl: new URL("https://music.example/rest/"),
    username: "alice",
    ping: unexpected("ping"),
    getAlbum: () => unexpected("getAlbum"),
    getAlbumList2: () => unexpected("getAlbumList2"),
    getIndexes: () => unexpected("getIndexes"),
    getCoverArt: () => unexpected("getCoverArt"),
    getPlaylists: unexpected("getPlaylists"),
    getPlaylist: () => unexpected("getPlaylist"),
    createPlaylist: () => unexpected("createPlaylist"),
    updatePlaylist: () => unexpected("updatePlaylist"),
    deletePlaylist: () => unexpected("deletePlaylist"),
    ...overrides,
  };
}

function managerLayer(db: MuswagDb, api: SubsonicApiService) {
  return SyncManager.layerWithoutDependencies.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(MuswagDatabase, db), Layer.succeed(SubsonicAPI, api))));
}

describe("SyncManager.sync", () => {
  it.effect("uses the saved watermark, upserts artists, removes stale records, and skips unchanged album details", () => {
    const unchanged = album("keep");
    const db = makeDatabase({
      albums: [unchanged, album("removed")],
      artists: [
        { id: "artist-keep", name: "Old name" },
        { id: "artist-removed", name: "Removed" },
      ],
      songs: [song("keep-song", unchanged.id), song("removed-song", "removed")],
      syncState: [{ id: 1, indexesLastModified: 42, lastFullSyncAt: null, lastQuickSyncAt: null }],
    });
    const indexCalls: Array<{ ifModifiedSince?: number }> = [];
    const api = makeApi({
      getIndexes: (args = {}) => {
        indexCalls.push(args);
        return Effect.succeed({
          status: "ok",
          version: "1.16.1",
          indexes: {
            lastModified: 43,
            index: [
              {
                name: "A",
                artist: [
                  { id: "artist-keep", name: "New name" },
                  { id: "artist-new", name: "New artist" },
                ],
              },
            ],
          },
        });
      },
      getAlbumList2: () =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          albumList2: { album: [unchanged] },
        }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      const result = yield* manager.sync({ mode: "default" });

      expect(result).toBeNull();
      expect(indexCalls).toEqual([{ ifModifiedSince: 42 }]);
      expect(db.artists.get("artist-keep")?.name).toBe("New name");
      expect([...db.artists.keys()].sort()).toEqual(["artist-keep", "artist-new"]);
      expect([...db.albums.keys()]).toEqual(["keep"]);
      expect([...db.songs.keys()]).toEqual(["keep-song"]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("bypasses shortcuts and replaces all songs for an existing album", () => {
    const listed = album("changed", { songCount: 2 });
    const details: AlbumWithSongsID3 = {
      ...listed,
      name: "Updated album",
      song: [song("new-1", listed.id), song("new-2", listed.id)],
    };
    const db = makeDatabase({
      albums: [album("changed", { name: "Local album", songCount: 2 })],
      songs: [song("stale", listed.id)],
    });
    const indexCalls: Array<{ ifModifiedSince?: number }> = [];
    const albumCalls: string[] = [];
    const api = makeApi({
      getIndexes: (args = {}) => {
        indexCalls.push(args);
        return Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } });
      },
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({ status: "ok", version: "1.16.1", album: details });
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "no_shortcuts" });

      expect(indexCalls).toEqual([{ ifModifiedSince: 0 }]);
      expect(albumCalls).toEqual(["changed"]);
      expect(db.albums.get("changed")?.name).toBe(listed.name);
      expect([...db.songs.keys()].sort()).toEqual(["new-1", "new-2"]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("inserts songs when syncing an album into a fresh library", () => {
    const listed = album("fresh");
    const db = makeDatabase();
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          album: { ...listed, song: [song("fresh-song", listed.id)] },
        }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "no_shortcuts" });

      expect([...db.albums.keys()]).toEqual([listed.id]);
      expect([...db.songs.keys()]).toEqual(["fresh-song"]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("repairs missing local songs even when quick-sync album metadata is unchanged", () => {
    const listed = album("partial", { songCount: 2 });
    const db = makeDatabase({ albums: [listed] });
    const albumCalls: string[] = [];
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({
          status: "ok",
          version: "1.16.1",
          album: { ...listed, song: [song("recovered-1", id), song("recovered-2", id)] },
        });
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "default" });

      expect(albumCalls).toEqual([listed.id]);
      expect([...db.songs.keys()].sort()).toEqual(["recovered-1", "recovered-2"]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("refetches album details when quick-sync metadata changes", () => {
    const listed = album("renamed", { name: "Server name" });
    const db = makeDatabase({
      albums: [album(listed.id, { name: "Local name" })],
      songs: [song("existing-song", listed.id)],
    });
    const albumCalls: string[] = [];
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({
          status: "ok",
          version: "1.16.1",
          album: { ...listed, song: [song("existing-song", id, { title: "Updated song" })] },
        });
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "default" });

      expect(albumCalls).toEqual([listed.id]);
      expect(db.albums.get(listed.id)?.name).toBe("Server name");
      expect(db.songs.get("existing-song")?.title).toBe("Updated song");
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("keeps artists when indexes are omitted while clearing an empty remote library", () => {
    const db = makeDatabase({
      albums: [album("removed")],
      artists: [{ id: "artist-keep", name: "Keep until indexes change" }],
      songs: [song("removed-song", "removed")],
    });
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: {} }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "default" });

      expect([...db.artists.keys()]).toEqual(["artist-keep"]);
      expect([...db.albums.keys()]).toEqual([]);
      expect([...db.songs.keys()]).toEqual([]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("accepts an album with no songs when its reported song count is zero", () => {
    const listed = album("instrumental-notes", { songCount: 0, duration: 0 });
    const db = makeDatabase();
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: listed }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "no_shortcuts" });

      expect(db.albums.get(listed.id)).toMatchObject(listed);
      expect([...db.songs.keys()]).toEqual([]);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("continues after a full album page and stops on the following empty page", () => {
    const albums = Array.from({ length: 500 }, (_, index) => album(`page-${index}`, { songCount: 0, duration: 0 }));
    const db = makeDatabase({ albums });
    const offsets: number[] = [];
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: ({ offset = 0 }) => {
        offsets.push(offset);
        return Effect.succeed({
          status: "ok",
          version: "1.16.1",
          albumList2: { album: offset === 0 ? albums : [] },
        });
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.sync({ mode: "default" });

      expect(offsets).toEqual([0, 500]);
      expect([...db.albums.keys()]).toHaveLength(500);
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("keeps albums without songs in the typed error channel", () => {
    const listed = album("empty");
    const db = makeDatabase();
    const api = makeApi({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: listed }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      const error = yield* Effect.flip(manager.sync({ mode: "no_shortcuts" }));

      expect(error).toMatchObject({ _tag: "AlbumWithoutSongs", id: "empty", expectedSongCount: 1 });
    }).pipe(Effect.provide(managerLayer(db, api)));
  });
});

describe("SyncManager.refreshStats", () => {
  it.effect("updates only album and existing-song stat fields", () => {
    const db = makeDatabase({
      albums: [album("stats", { name: "Local album", playCount: 1, starred: "old" })],
      songs: [song("known", "stats", { title: "Local song", playCount: 2, starred: "old" })],
    });
    const api = makeApi({
      getAlbum: () =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          album: {
            ...album("stats", { name: "Server album", playCount: 10, userRating: 4 }),
            song: [song("known", "stats", { title: "Server song", playCount: 20, userRating: 5 }), song("not-local", "stats", { playCount: 30 })],
          },
        }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.refreshStats({ type: "album", id: "stats" });

      expect(db.albums.get("stats")).toMatchObject({ name: "Local album", playCount: 10, userRating: 4 });
      expect(db.songs.get("known")).toMatchObject({ title: "Local song", playCount: 20, userRating: 5 });
      expect(db.songs.get("not-local")).toBeUndefined();
    }).pipe(Effect.provide(managerLayer(db, api)));
  });

  it.effect("updates only existing-song stat fields from a playlist", () => {
    const db = makeDatabase({
      songs: [song("known", "album", { title: "Local song", playCount: 2, bookmarkPosition: 10 })],
    });
    const api = makeApi({
      getPlaylist: ({ id }) =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          playlist: playlist(id, [song("known", "album", { title: "Server song", playCount: 8, averageRating: 3 }), song("not-local", "album", { playCount: 9 })]),
        }),
    });

    return Effect.gen(function* () {
      const manager = yield* SyncManager;
      yield* manager.refreshStats({ type: "playlist", id: "playlist-1" });

      expect(db.songs.get("known")).toMatchObject({ title: "Local song", playCount: 8, averageRating: 3 });
      expect(db.songs.get("not-local")).toBeUndefined();
    }).pipe(Effect.provide(managerLayer(db, api)));
  });
});
