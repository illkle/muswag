import { describe, expect, it } from "@effect/vitest";
import { albums, artists, songs, syncState, type AlbumWithSongsID3 } from "@muswag/model";
import { Cause, Effect, Exit, Fiber, Layer } from "effect";

import type { SubsonicApiService } from "../api/subsonic-api.js";
import { Db } from "../db/database.js";
import { apiAlbum as album, apiLayer, apiPlaylist as playlist, apiSong as song, idsOf, rowOf, seed, TestDatabase } from "../test/index.js";
import { LibrarySync } from "./library-sync.js";

const layer = (api: Partial<SubsonicApiService>) => LibrarySync.layer.pipe(Layer.provideMerge(Layer.mergeAll(TestDatabase(), apiLayer(api))));

const indexes =
  (lastModified = 1) =>
  () =>
    Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified } });

describe("LibrarySync.sync", () => {
  it.effect("uses the saved watermark, upserts artists, removes stale records, and skips unchanged album details", () => {
    const unchanged = album("keep");
    const indexCalls: Array<{ ifModifiedSince?: number }> = [];
    const api: Partial<SubsonicApiService> = {
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
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [unchanged] } }),
    };

    return Effect.gen(function* () {
      yield* seed({
        albums: [unchanged, album("removed")],
        artists: [
          { id: "artist-keep", name: "Old name" },
          { id: "artist-removed", name: "Removed" },
        ],
        songs: [song("keep-song", unchanged.id), song("removed-song", "removed")],
      });
      const db = yield* Db;
      yield* db.insert(syncState).values({ id: 1, indexesLastModified: 42 });

      const sync = yield* LibrarySync;
      yield* sync.sync("quick");

      expect(indexCalls).toEqual([{ ifModifiedSince: 42 }]);
      expect((yield* rowOf(artists, "artist-keep"))?.name).toBe("New name");
      expect(yield* idsOf(artists)).toEqual(["artist-keep", "artist-new"]);
      expect(yield* idsOf(albums)).toEqual(["keep"]);
      expect(yield* idsOf(songs)).toEqual(["keep-song"]);
      const [state] = yield* db.select().from(syncState);
      expect(state).toMatchObject({ indexesLastModified: 43, lastQuickSyncAt: expect.any(String), lastFullSyncAt: null });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("bypasses shortcuts and replaces all songs for an existing album", () => {
    const listed = album("changed", { songCount: 2 });
    const details: AlbumWithSongsID3 = { ...listed, name: "Updated album", song: [song("new-1", listed.id), song("new-2", listed.id)] };
    const indexCalls: Array<{ ifModifiedSince?: number }> = [];
    const albumCalls: string[] = [];
    const api: Partial<SubsonicApiService> = {
      getIndexes: (args = {}) => {
        indexCalls.push(args);
        return Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } });
      },
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({ status: "ok", version: "1.16.1", album: details });
      },
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("changed", { name: "Local album", songCount: 2 })], songs: [song("stale", listed.id)] });

      yield* (yield* LibrarySync).sync("full");

      expect(indexCalls).toEqual([{ ifModifiedSince: 0 }]);
      expect(albumCalls).toEqual(["changed"]);
      expect((yield* rowOf(albums, "changed"))?.name).toBe(listed.name);
      expect(yield* idsOf(songs)).toEqual(["new-1", "new-2"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("inserts songs when syncing an album into a fresh library", () => {
    const listed = album("fresh");
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: { ...listed, song: [song("fresh-song", listed.id, { genres: [{ name: "jazz" }] })] } }),
    };

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("full");

      expect(yield* idsOf(albums)).toEqual([listed.id]);
      expect(yield* rowOf(songs, "fresh-song")).toMatchObject({ albumId: listed.id, isDir: false, genres: [{ name: "jazz" }], year: null });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("repairs missing local songs even when quick-sync album metadata is unchanged", () => {
    const listed = album("partial", { songCount: 2 });
    const albumCalls: string[] = [];
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({ status: "ok", version: "1.16.1", album: { ...listed, song: [song("recovered-1", id), song("recovered-2", id)] } });
      },
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [listed] });

      yield* (yield* LibrarySync).sync("quick");

      expect(albumCalls).toEqual([listed.id]);
      expect(yield* idsOf(songs)).toEqual(["recovered-1", "recovered-2"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("refetches album details when quick-sync metadata changes", () => {
    const listed = album("renamed", { name: "Server name" });
    const albumCalls: string[] = [];
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: ({ id }) => {
        albumCalls.push(id);
        return Effect.succeed({ status: "ok", version: "1.16.1", album: { ...listed, song: [song("existing-song", id, { title: "Updated song" })] } });
      },
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album(listed.id, { name: "Local name" })], songs: [song("existing-song", listed.id)] });

      yield* (yield* LibrarySync).sync("quick");

      expect(albumCalls).toEqual([listed.id]);
      expect((yield* rowOf(albums, listed.id))?.name).toBe("Server name");
      expect((yield* rowOf(songs, "existing-song"))?.title).toBe("Updated song");
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps cover fields and clears server fields the album no longer has", () => {
    const listed = album("covered", { songCount: 0 });
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: listed }),
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [{ ...listed, starred: "2026-01-01" }] });
      const db = yield* Db;
      yield* db.update(albums).set({ coverArtPath: "covers/a.jpg", coverArtSourceId: "c1" });

      yield* (yield* LibrarySync).sync("full");

      expect(yield* rowOf(albums, listed.id)).toMatchObject({ starred: null, coverArtPath: "covers/a.jpg", coverArtSourceId: "c1" });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps artists when indexes are omitted while clearing an empty remote library", () => {
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: {} }),
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("removed")], artists: [{ id: "artist-keep", name: "Keep until indexes change" }], songs: [song("removed-song", "removed")] });

      yield* (yield* LibrarySync).sync("quick");

      expect(yield* idsOf(artists)).toEqual(["artist-keep"]);
      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("accepts an album with no songs when its reported song count is zero", () => {
    const listed = album("instrumental-notes", { songCount: 0, duration: 0 });
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: listed }),
    };

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("full");

      expect(yield* rowOf(albums, listed.id)).toMatchObject(listed);
      expect(yield* idsOf(songs)).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("continues after a full album page and stops on the following empty page", () => {
    const page = Array.from({ length: 500 }, (_, index) => album(`page-${index}`, { songCount: 0, duration: 0 }));
    const offsets: number[] = [];
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: ({ offset = 0 }) => {
        offsets.push(offset);
        return Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: offset === 0 ? page : [] } });
      },
    };

    return Effect.gen(function* () {
      yield* seed({ albums: page });

      yield* (yield* LibrarySync).sync("quick");

      expect(offsets).toEqual([0, 500]);
      expect(yield* idsOf(albums)).toHaveLength(500);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps albums without songs in the typed error channel", () => {
    const listed = album("empty");
    const api: Partial<SubsonicApiService> = {
      getIndexes: indexes(),
      getAlbumList2: () => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: [listed] } }),
      getAlbum: () => Effect.succeed({ status: "ok", version: "1.16.1", album: listed }),
    };

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      const error = yield* Effect.flip(sync.sync("full"));

      expect(error).toMatchObject({ _tag: "AlbumWithoutSongs", id: "empty", expectedSongCount: 1 });
      expect(yield* sync.status).toMatchObject({ running: null, error: expect.stringContaining("AlbumWithoutSongs") });
    }).pipe(Effect.provide(layer(api)));
  });

  it.live("joins a running sync of the same mode and rejects another mode", () => {
    let listCalls = 0;
    const api: Partial<SubsonicApiService> = {
      getIndexes: () => Effect.sleep("10 millis").pipe(Effect.andThen(indexes()())),
      getAlbumList2: () => {
        listCalls += 1;
        return Effect.succeed({ status: "ok", version: "1.16.1", albumList2: {} });
      },
    };

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      const first = yield* Effect.forkChild(sync.sync("quick"));
      yield* Effect.yieldNow;
      expect(yield* sync.status).toMatchObject({ running: "quick" });

      const rejected = yield* Effect.flip(sync.sync("full"));
      yield* sync.sync("quick");
      yield* Fiber.join(first);

      expect(rejected._tag).toBe("SyncAlreadyRunning");
      expect(listCalls).toBe(1);
      expect(yield* sync.status).toMatchObject({ running: null, error: null, lastSyncedAt: expect.any(String) });
    }).pipe(Effect.provide(layer(api)));
  });
});

describe("LibrarySync.cancel", () => {
  it.live("interrupts the running sync and lets the next one start", () => {
    let listCalls = 0;
    const api: Partial<SubsonicApiService> = {
      getIndexes: () => Effect.never,
      getAlbumList2: () => {
        listCalls += 1;
        return Effect.succeed({ status: "ok", version: "1.16.1", albumList2: {} });
      },
    };

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      const waiter = yield* Effect.forkChild(Effect.exit(sync.sync("quick")));
      yield* Effect.sleep("10 millis");

      yield* sync.cancel;
      const exit = yield* Fiber.join(waiter);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(yield* sync.status).toMatchObject({ running: null, error: null });
      expect(listCalls).toBe(0);
    }).pipe(Effect.provide(layer(api)));
  });
});

describe("LibrarySync.refreshStats", () => {
  it.effect("updates only album and existing-song stat fields", () => {
    const api: Partial<SubsonicApiService> = {
      getAlbum: () =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          album: {
            ...album("stats", { name: "Server album", playCount: 10, userRating: 4 }),
            song: [song("known", "stats", { title: "Server song", playCount: 20, userRating: 5 }), song("not-local", "stats", { playCount: 30 })],
          },
        }),
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("stats", { name: "Local album", playCount: 1, starred: "old" })], songs: [song("known", "stats", { title: "Local song", playCount: 2, starred: "old" })] });

      yield* (yield* LibrarySync).refreshStats({ type: "album", id: "stats" });

      expect(yield* rowOf(albums, "stats")).toMatchObject({ name: "Local album", playCount: 10, userRating: 4, starred: null });
      expect(yield* rowOf(songs, "known")).toMatchObject({ title: "Local song", playCount: 20, userRating: 5, starred: null });
      expect(yield* rowOf(songs, "not-local")).toBeUndefined();
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("updates only existing-song stat fields from a playlist", () => {
    const api: Partial<SubsonicApiService> = {
      getPlaylist: ({ id }) =>
        Effect.succeed({
          status: "ok",
          version: "1.16.1",
          playlist: playlist(id, [song("known", "album", { title: "Server song", playCount: 8, averageRating: 3 }), song("not-local", "album", { playCount: 9 })]),
        }),
    };

    return Effect.gen(function* () {
      yield* seed({ songs: [song("known", "album", { title: "Local song", playCount: 2, bookmarkPosition: 10 })] });

      yield* (yield* LibrarySync).refreshStats({ type: "playlist", id: "playlist-1" });

      expect(yield* rowOf(songs, "known")).toMatchObject({ title: "Local song", playCount: 8, averageRating: 3, bookmarkPosition: null });
      expect(yield* rowOf(songs, "not-local")).toBeUndefined();
    }).pipe(Effect.provide(layer(api)));
  });
});
