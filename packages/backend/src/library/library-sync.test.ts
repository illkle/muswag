import { describe, expect, it } from "@effect/vitest";
import { albums, artists, songs, SubsonicApiError, SubsonicHttpError, syncState, type AlbumWithSongsID3, type ArtistID3, type Child } from "@muswag/model";
import { eq } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";

import type { SubsonicApiService } from "../api/subsonic-api.js";
import { LibraryChanges, type LibraryChange } from "../db/changes.js";
import { Db } from "../db/database.js";
import { apiAlbum as album, apiLayer, apiPlaylist as playlist, apiSong as song, idsOf, rowOf, seed, TestDatabase } from "../test/index.js";
import { LibrarySync } from "./library-sync.js";

const layer = (api: Partial<SubsonicApiService>) => LibrarySync.layer.pipe(Layer.provideMerge(Layer.mergeAll(TestDatabase(), apiLayer(api))));

const ok = { status: "ok", version: "1.16.1" } as const;

interface Server {
  artists?: ArtistID3[];
  albums?: AlbumWithSongsID3[];
  /** What `getScanStatus` gives as `lastScan`; `undefined` for a server that does not say. */
  scan?: string;
  /** How `search3` answers an empty query: with every song, with none, or with an error. */
  search?: "all" | "none" | "error";
  /** The most albums the server gives a page, whatever is asked for. */
  albumPageLimit?: number;
  /** The most songs `search3` gives a page, whatever is asked for. */
  songPageLimit?: number;
}

/** A fake server over `server`, which tests may change between syncs, recording the calls made. */
const fakeServer = (server: Server) => {
  const calls = { getAlbum: [] as string[], search3: [] as number[], albumList: [] as number[] };
  // Writable, so a test can wrap a method.
  const api: { -readonly [K in keyof SubsonicApiService]?: SubsonicApiService[K] } = {
    getScanStatus: Effect.sync(() => ({ ...ok, scanStatus: { scanning: false, ...(server.scan !== undefined && { lastScan: server.scan, count: 1 }) } })),
    getArtists: () => Effect.sync(() => ({ ...ok, artists: { index: [{ name: "A", artist: server.artists ?? [] }] } })),
    getAlbumList2: ({ offset = 0, size = 10 }) =>
      Effect.sync(() => {
        calls.albumList.push(offset);
        const listed = (server.albums ?? []).map(({ song: _song, ...listed }) => listed);
        return { ...ok, albumList2: { album: listed.slice(offset, offset + Math.min(size, server.albumPageLimit ?? size)) } };
      }),
    getAlbum: ({ id }) =>
      Effect.suspend(() => {
        calls.getAlbum.push(id);
        const found = server.albums?.find((album) => album.id === id);
        return found ? Effect.succeed({ ...ok, album: found }) : Effect.fail(new SubsonicApiError({ method: "getAlbum", code: 70, message: "Album not found" }));
      }),
    search3: ({ songOffset = 0, songCount = 20 }) =>
      Effect.suspend(() => {
        calls.search3.push(songOffset);
        if (server.search === "error") return Effect.fail(new SubsonicApiError({ method: "search3", code: 10, message: "Required parameter is missing: query" }));
        const every: Child[] = server.search === "none" ? [] : (server.albums ?? []).flatMap((album) => album.song ?? []);
        return Effect.succeed({ ...ok, searchResult3: { song: every.slice(songOffset, songOffset + Math.min(songCount, server.songPageLimit ?? songCount)) } });
      }),
  };
  return { api, calls };
};

/** An album as the server holds it, with `count` songs. */
const withSongs = (id: string, count: number, overrides: Partial<AlbumWithSongsID3> = {}): AlbumWithSongsID3 => ({
  ...album(id, { songCount: count }),
  song: Array.from({ length: count }, (_, index) => song(`${id}-song-${index}`, id)),
  ...overrides,
});

const savedState = Db.use((db) => db.select().from(syncState).where(eq(syncState.id, 1))).pipe(Effect.map(([state]) => state));

describe("LibrarySync.sync", () => {
  it.effect("reads every song through search3 after a scan, and only the albums that look changed while the scan is the same", () => {
    const server: Server = { scan: "scan-1", albums: [withSongs("a", 2), withSongs("b", 1)], artists: [{ id: "artist-1", name: "Artist" }] };
    const { api, calls } = fakeServer(server);

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      yield* sync.sync("quick");

      // Until a page comes back empty, a few at once after the first.
      expect(calls.search3).toEqual([0, 3, 6, 9, 12]);
      expect(calls.getAlbum).toEqual([]);
      expect(yield* idsOf(songs)).toEqual(["a-song-0", "a-song-1", "b-song-0"]);
      expect(yield* savedState).toMatchObject({ serverScan: "scan-1 1", lastSyncedAt: expect.any(String) });

      // The same scan: album b changed its name, a only its play count.
      server.albums = [{ ...withSongs("a", 2), playCount: 5 }, withSongs("b", 1, { name: "Renamed", song: [song("b-song-0", "b", { title: "Retitled" })] })];
      calls.search3.length = 0;
      yield* sync.sync("quick");

      expect(calls.search3).toEqual([]);
      expect(calls.getAlbum).toEqual(["b"]);
      expect((yield* rowOf(albums, "a"))?.playCount).toBe(5);
      expect((yield* rowOf(songs, "b-song-0"))?.title).toBe("Retitled");
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("removes the songs search3 no longer lists and reads an album left short with getAlbum", () => {
    const server: Server = { scan: "scan-1", albums: [withSongs("a", 2)] };
    const { api, calls } = fakeServer(server);
    // search3 misses one of the album's songs, as when the library changes between its pages.
    const search3 = api.search3!;
    api.search3 = (args) => search3(args).pipe(Effect.map((result) => ({ ...result, searchResult3: { song: result.searchResult3.song?.filter(({ id }) => id !== "a-song-1") } })));

    return Effect.gen(function* () {
      yield* seed({ albums: [album("a", { songCount: 2 })], songs: [song("gone", "a"), song("a-song-0", "a")] });

      yield* (yield* LibrarySync).sync("quick");

      expect(calls.getAlbum).toEqual(["a"]);
      expect(yield* idsOf(songs)).toEqual(["a-song-0", "a-song-1"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("reads every album with getAlbum from a server whose search3 finds nothing or refuses an empty query", () =>
    Effect.gen(function* () {
      for (const search of ["none", "error"] as const) {
        const { api, calls } = fakeServer({ scan: "scan-1", search, albums: [withSongs("a", 1), withSongs("b", 1)] });
        yield* Effect.gen(function* () {
          yield* (yield* LibrarySync).sync("quick");
          expect(calls.getAlbum.sort()).toEqual(["a", "b"]);
          expect(yield* idsOf(songs)).toEqual(["a-song-0", "b-song-0"]);
        }).pipe(Effect.provide(layer(api)));
      }
    }),
  );

  it.effect("reads only the albums that look changed after a scan when search3 cannot list every song, and all of them in a full sync", () => {
    const { api, calls } = fakeServer({ scan: "scan-2", search: "error", albums: [withSongs("same", 1), withSongs("renamed", 1, { name: "New name" })] });

    return Effect.gen(function* () {
      yield* seed({ albums: [album("same"), album("renamed", { name: "Old name" })], songs: [song("same-song-0", "same"), song("renamed-song-0", "renamed")] });
      const db = yield* Db;
      yield* db.insert(syncState).values({ id: 1, serverScan: "scan-1 1" });
      const sync = yield* LibrarySync;

      yield* sync.sync("quick");
      expect(calls.getAlbum).toEqual(["renamed"]);

      calls.getAlbum.length = 0;
      yield* sync.sync("full");
      expect(calls.getAlbum.sort()).toEqual(["renamed", "same"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("goes on without a scan marker from a server that answers getScanStatus with an HTTP error", () => {
    const { api } = fakeServer({ albums: [withSongs("a", 1)] });
    api.getScanStatus = Effect.fail(new SubsonicHttpError({ method: "getScanStatus", status: 501, message: "getScanStatus failed: HTTP 501" }));

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("quick");
      expect(yield* idsOf(songs)).toEqual(["a-song-0"]);
      expect((yield* savedState)?.serverScan).toBeNull();
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("reads the pages after the first a few at once, as long as the first, and reports each in order", () => {
    const { api, calls } = fakeServer({ scan: "scan-1", albums: [withSongs("a", 5), withSongs("b", 4)], songPageLimit: 2 });
    const reported: Array<number | undefined> = [];

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      yield* Effect.forkChild(Stream.runForEach(sync.changes, ({ progress }) => Effect.sync(() => void reported.push(progress?.done))));
      yield* Effect.yieldNow;
      yield* sync.sync("full");

      expect(calls.search3).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
      expect(calls.getAlbum).toEqual([]);
      expect(yield* idsOf(songs)).toHaveLength(9);
      expect(reported.filter((done) => done !== undefined)).toEqual([0, 2, 4, 6, 8, 9]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("stops paging a server that ignores the offset and answers with the same page again", () => {
    const { api, calls } = fakeServer({ scan: "scan-1", albums: [withSongs("a", 2)] });
    const getAlbumList2 = api.getAlbumList2!;
    const search3 = api.search3!;
    api.getAlbumList2 = (args) => getAlbumList2({ ...args, offset: 0 }).pipe(Effect.tap(() => Effect.sync(() => void calls.albumList.push(args.offset ?? 0))));
    api.search3 = (args) => search3({ ...args, songOffset: 0 });

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("full");
      expect(calls.search3).toEqual([0, 0, 0, 0, 0]);
      expect(yield* idsOf(albums)).toEqual(["a"]);
      expect(yield* idsOf(songs)).toEqual(["a-song-0", "a-song-1"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("relies on how the albums look when the server does not report its scans, and reads every song in a full sync", () => {
    const server: Server = { albums: [withSongs("a", 1)] };
    const { api, calls } = fakeServer(server);

    return Effect.gen(function* () {
      yield* seed({ albums: [album("a")], songs: [song("a-song-0", "a")] });
      const sync = yield* LibrarySync;

      yield* sync.sync("quick");
      expect(calls.search3).toEqual([]);
      expect(calls.getAlbum).toEqual([]);

      yield* sync.sync("full");
      expect(calls.search3).toEqual([0, 1, 2, 3, 4]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("writes nothing a renderer would hear of when nothing changed", () => {
    const { api } = fakeServer({ scan: "scan-1", albums: [withSongs("a", 3)], artists: [{ id: "artist-1", name: "Artist" }] });

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      yield* sync.sync("full");
      const changes: Array<LibraryChange> = [];
      (yield* LibraryChanges).subscribe((written) => changes.push(...written));
      yield* sync.sync("full");
      expect(changes).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("upserts artists and removes the albums, songs and artists the server no longer has", () => {
    const { api } = fakeServer({
      scan: "scan-1",
      albums: [withSongs("keep", 1)],
      artists: [
        { id: "artist-keep", name: "New name", albumCount: 1 },
        { id: "artist-new", name: "New artist" },
      ],
    });

    return Effect.gen(function* () {
      yield* seed({
        albums: [album("keep"), album("removed")],
        artists: [
          { id: "artist-keep", name: "Old name" },
          { id: "artist-removed", name: "Removed" },
        ],
        songs: [song("keep-song-0", "keep"), song("removed-song", "removed"), song("orphan", "never-listed")],
      });

      yield* (yield* LibrarySync).sync("quick");

      expect(yield* rowOf(artists, "artist-keep")).toMatchObject({ name: "New name", albumCount: 1 });
      expect(yield* idsOf(artists)).toEqual(["artist-keep", "artist-new"]);
      expect(yield* idsOf(albums)).toEqual(["keep"]);
      expect(yield* idsOf(songs)).toEqual(["keep-song-0"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("removes songs left without an album even when no album is removed", () => {
    const { api } = fakeServer({ albums: [withSongs("a", 1)] });

    return Effect.gen(function* () {
      yield* seed({ albums: [album("a")], songs: [song("a-song-0", "a"), song("orphan", "elsewhere")] });
      yield* (yield* LibrarySync).sync("quick");
      expect(yield* idsOf(songs)).toEqual(["a-song-0"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("clears a library the server has emptied", () => {
    const { api } = fakeServer({ scan: "scan-1" });

    return Effect.gen(function* () {
      yield* seed({ albums: [album("removed")], artists: [{ id: "artist", name: "Artist" }], songs: [song("removed-song", "removed")] });
      yield* (yield* LibrarySync).sync("quick");
      expect(yield* idsOf(artists)).toEqual([]);
      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps asking for albums until a page comes back empty, whatever the server gives a page", () => {
    const listed = Array.from({ length: 1_200 }, (_, index) => withSongs(`album-${String(index).padStart(4, "0")}`, 0, { duration: 0 }));
    const { api, calls } = fakeServer({ albums: listed, albumPageLimit: 100 });

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("quick");
      expect(calls.albumList).toEqual(Array.from({ length: 13 }, (_, index) => index * 100));
      expect(yield* idsOf(albums)).toHaveLength(1_200);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("accepts an album with no songs when its reported song count is zero", () => {
    const listed = withSongs("instrumental-notes", 0, { duration: 0, song: undefined });
    const { api } = fakeServer({ albums: [listed], search: "none" });

    return Effect.gen(function* () {
      yield* (yield* LibrarySync).sync("full");
      expect(yield* idsOf(albums)).toEqual([listed.id]);
      expect(yield* idsOf(songs)).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("syncs the other albums when one cannot be read, says so, and has the next sync read every song", () => {
    // One answers with no songs at all, the other with an empty list of them.
    const server: Server = { scan: "scan-1", albums: [withSongs("broken", 1, { song: undefined }), withSongs("empty", 1, { song: [] }), withSongs("fine", 1)] };
    const { api, calls } = fakeServer(server);
    // search3 does not have the songs of the broken albums either.
    const search3 = api.search3!;
    api.search3 = (args) => search3(args).pipe(Effect.map((result) => ({ ...result, searchResult3: { song: result.searchResult3.song?.filter(({ albumId }) => albumId === "fine") } })));

    return Effect.gen(function* () {
      yield* seed({ albums: [album("empty")], songs: [song("empty-song-0", "empty")] });
      const sync = yield* LibrarySync;
      yield* sync.sync("quick");

      expect(yield* idsOf(albums)).toEqual(["broken", "empty", "fine"]);
      // What the empty answer would have removed is kept.
      expect(yield* idsOf(songs)).toEqual(["empty-song-0", "fine-song-0"]);
      expect(yield* sync.status).toMatchObject({ running: null, progress: null, error: expect.stringContaining("2 albums could not be synced"), lastSyncedAt: expect.any(String) });
      expect((yield* savedState)?.serverScan).toBeNull();

      calls.search3.length = 0;
      yield* sync.sync("quick");
      expect(calls.search3.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps the songs of an album search3 left short when getAlbum then fails", () => {
    const { api } = fakeServer({ scan: "scan-1", albums: [withSongs("a", 2)] });
    const search3 = api.search3!;
    api.search3 = (args) => search3(args).pipe(Effect.map((result) => ({ ...result, searchResult3: { song: result.searchResult3.song?.filter(({ id }) => id !== "a-song-1") } })));
    api.getAlbum = () => Effect.fail(new SubsonicApiError({ method: "getAlbum", code: 0, message: "The server failed" }));

    return Effect.gen(function* () {
      yield* seed({ albums: [album("a", { songCount: 2 })], songs: [song("a-song-0", "a"), song("a-song-1", "a")] });
      yield* (yield* LibrarySync).sync("full");
      expect(yield* idsOf(songs)).toEqual(["a-song-0", "a-song-1"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("tries an album that looked changed again on the next sync after reading it failed, from a server that does not report its scans", () => {
    const server: Server = { albums: [withSongs("a", 1, { name: "New name", song: [song("a-song-0", "a", { title: "New title" })] })] };
    const { api, calls } = fakeServer(server);
    const getAlbum = api.getAlbum!;
    let failing = true;
    api.getAlbum = (args) =>
      failing
        ? Effect.sync(() => void calls.getAlbum.push(args.id)).pipe(Effect.andThen(Effect.fail(new SubsonicApiError({ method: "getAlbum", code: 0, message: "The server failed" }))))
        : getAlbum(args);

    return Effect.gen(function* () {
      yield* seed({ albums: [album("a", { name: "Old name" })], songs: [song("a-song-0", "a")] });
      const sync = yield* LibrarySync;

      yield* sync.sync("quick");
      expect(calls.getAlbum).toEqual(["a"]);
      expect((yield* rowOf(albums, "a"))?.name).toBe("Old name");

      yield* sync.sync("quick");
      expect(calls.getAlbum).toEqual(["a", "a"]);

      failing = false;
      yield* sync.sync("quick");
      expect((yield* rowOf(albums, "a"))?.name).toBe("New name");
      expect((yield* rowOf(songs, "a-song-0"))?.title).toBe("New title");
      expect((yield* sync.status).error).toBeNull();
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("fails the sync when the server does not answer", () => {
    const { api } = fakeServer({});
    api.getAlbumList2 = () => Effect.fail(new SubsonicApiError({ method: "getAlbumList2", code: 0, message: "The server failed" }));

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      const error = yield* Effect.flip(sync.sync("quick"));
      expect(error).toMatchObject({ _tag: "SubsonicApiError" });
      expect(yield* sync.status).toMatchObject({ running: null, error: "The server failed", lastSyncedAt: null });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("keeps the cover file of an unchanged cover and clears server fields the album no longer has", () => {
    const listed = withSongs("covered", 0, { coverArt: "c1" });
    const { api } = fakeServer({ albums: [listed] });

    return Effect.gen(function* () {
      yield* seed({ albums: [{ ...album("covered", { songCount: 0, coverArt: "c1" }), starred: "2026-01-01" }] });
      const db = yield* Db;
      yield* db.update(albums).set({ coverArtPath: "covers/a" });

      yield* (yield* LibrarySync).sync("full");

      expect(yield* rowOf(albums, listed.id)).toMatchObject({ starred: null, coverArt: "c1", coverArtPath: "covers/a" });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("forgets the cover file of an album or artist whose cover is another one on the server", () => {
    const changed = withSongs("changed", 0, { coverArt: "c2" });
    const coverless = withSongs("coverless", 0);
    const { api } = fakeServer({
      albums: [changed, coverless],
      artists: [
        { id: "artist-changed", name: "Changed", coverArt: "ar-2" },
        { id: "artist-same", name: "Same", coverArt: "ar-1" },
      ],
    });

    return Effect.gen(function* () {
      yield* seed({ albums: [album("changed", { songCount: 0, coverArt: "c1" }), album("coverless", { songCount: 0 })] });
      const db = yield* Db;
      yield* db.update(albums).set({ coverArtPath: "covers/a" });
      yield* db.insert(artists).values([
        { id: "artist-changed", name: "Changed", coverArt: "ar-1", coverArtPath: "covers/changed" },
        { id: "artist-same", name: "Same", coverArt: "ar-1", coverArtPath: "covers/same" },
      ]);

      yield* (yield* LibrarySync).sync("full");

      expect(yield* rowOf(albums, changed.id)).toMatchObject({ coverArt: "c2", coverArtPath: null });
      // No cover before and none now is no change either.
      expect(yield* rowOf(albums, coverless.id)).toMatchObject({ coverArt: null, coverArtPath: "covers/a" });
      expect(yield* rowOf(artists, "artist-changed")).toMatchObject({ coverArt: "ar-2", coverArtPath: null });
      expect(yield* rowOf(artists, "artist-same")).toMatchObject({ coverArt: "ar-1", coverArtPath: "covers/same" });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("joins a running sync that does as much, and runs a full one asked for during a quick one after it", () => {
    const { api, calls } = fakeServer({});
    const gate = Deferred.makeUnsafe<void>();
    const getArtists = api.getArtists!;
    api.getArtists = (args) => Deferred.await(gate).pipe(Effect.andThen(getArtists(args)));

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      const quick = yield* Effect.forkChild(sync.sync("quick"));
      yield* Effect.yieldNow;
      expect(yield* sync.status).toMatchObject({ running: "quick" });

      const joined = yield* Effect.forkChild(sync.sync("quick"));
      const full = yield* Effect.forkChild(sync.sync("full"));
      yield* Effect.yieldNow;
      expect(calls.albumList).toEqual([]);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(quick);
      yield* Fiber.join(joined);
      yield* Fiber.join(full);

      // The quick sync and the one that joined it list the albums once; the full one after them again.
      expect(calls.albumList).toEqual([0, 0]);
      expect(yield* sync.status).toMatchObject({ running: null, error: null, lastSyncedAt: expect.any(String) });
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("starts with the time of the last sync, and syncs when that is too long ago", () => {
    const { api, calls } = fakeServer({});

    return Effect.gen(function* () {
      const sync = yield* LibrarySync;
      yield* sync.sync("quick");
      yield* sync.syncIfStale(60_000);
      expect(calls.albumList).toEqual([0]);
      yield* sync.syncIfStale(-1);
      expect(calls.albumList).toEqual([0, 0]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("reports the time of the last sync of an earlier session", () =>
    Effect.gen(function* () {
      const db = yield* Db;
      yield* db.insert(syncState).values({ id: 1, lastSyncedAt: "2026-10-01T00:00:00.000Z" });
      const sync = yield* Effect.provide(LibrarySync.make, apiLayer());
      expect((yield* sync.status).lastSyncedAt).toBe("2026-10-01T00:00:00.000Z");
    }).pipe(Effect.provide(layer({}))),
  );
});

describe("LibrarySync.refresh", () => {
  it.effect("writes the album and every song it has now", () => {
    const api: Partial<SubsonicApiService> = {
      getAlbum: () =>
        Effect.succeed({
          ...ok,
          album: { ...album("album", { name: "Server album", playCount: 10, songCount: 2 }), song: [song("known", "album", { title: "Server song", playCount: 20 }), song("new", "album")] },
        }),
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("album", { name: "Local album", starred: "old" })], songs: [song("known", "album", { title: "Local song", starred: "old" }), song("gone", "album")] });

      yield* (yield* LibrarySync).refresh({ type: "album", id: "album" });

      expect(yield* rowOf(albums, "album")).toMatchObject({ name: "Server album", playCount: 10, starred: null });
      expect(yield* rowOf(songs, "known")).toMatchObject({ title: "Server song", playCount: 20, starred: null });
      expect(yield* idsOf(songs)).toEqual(["known", "new"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("sends renderers only the rows that changed", () => {
    let playCount = 3;
    const api: Partial<SubsonicApiService> = {
      getAlbum: () =>
        Effect.succeed({
          ...ok,
          album: { ...album("stats", { playCount: 10, songCount: 2 }), song: [song("same", "stats", { playCount: 2, starred: "2026-01-01" }), song("played", "stats", { playCount })] },
        }),
    };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("stats", { playCount: 10, songCount: 2 })], songs: [song("same", "stats", { playCount: 2, starred: "2026-01-01" }), song("played", "stats", { playCount: 3 })] });
      const changes: Array<LibraryChange> = [];
      (yield* LibraryChanges).subscribe((written) => changes.push(...written));
      const library = yield* LibrarySync;

      yield* library.refresh({ type: "album", id: "stats" });
      expect(changes).toEqual([]);

      playCount = 4;
      yield* library.refresh({ type: "album", id: "stats" });
      expect(changes.map(({ table, key }) => `${table}:${key}`)).toEqual(["songs:played"]);
      expect((yield* rowOf(songs, "played"))?.playCount).toBe(4);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("leaves the songs of an album the server answers with none of", () => {
    const api: Partial<SubsonicApiService> = { getAlbum: () => Effect.succeed({ ...ok, album: { ...album("album"), song: [] } }) };

    return Effect.gen(function* () {
      yield* seed({ albums: [album("album")], songs: [song("kept", "album")] });
      const error = yield* Effect.flip((yield* LibrarySync).refresh({ type: "album", id: "album" }));
      expect(error).toMatchObject({ _tag: "AlbumWithoutSongs" });
      expect(yield* idsOf(songs)).toEqual(["kept"]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("writes nothing once the session it belongs to has closed", () => {
    const answer = Deferred.makeUnsafe<void>();
    const asked = Deferred.makeUnsafe<void>();
    const api: Partial<SubsonicApiService> = {
      getAlbum: () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer)), Effect.as({ ...ok, album: { ...album("album"), song: [song("song", "album")] } })),
    };

    return Effect.gen(function* () {
      const session = yield* Scope.make();
      const library = yield* LibrarySync.make.pipe(Scope.provide(session));
      const refreshing = yield* Effect.forkChild(library.refresh({ type: "album", id: "album" }));
      yield* Deferred.await(asked);

      yield* Scope.close(session, Exit.void);
      yield* Deferred.succeed(answer, undefined);
      yield* Fiber.await(refreshing);

      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
    }).pipe(Effect.provide(layer(api)));
  });

  it.effect("writes the songs of a playlist that the library has, and only those", () => {
    const api: Partial<SubsonicApiService> = {
      getPlaylist: ({ id }) => Effect.succeed({ ...ok, playlist: playlist(id, [song("known", "album", { title: "Server song", playCount: 8 }), song("not-local", "album")]) }),
    };

    return Effect.gen(function* () {
      yield* seed({ songs: [song("known", "album", { title: "Local song", bookmarkPosition: 10 })] });

      yield* (yield* LibrarySync).refresh({ type: "playlist", id: "playlist-1" });

      expect(yield* rowOf(songs, "known")).toMatchObject({ title: "Server song", playCount: 8, bookmarkPosition: null });
      expect(yield* rowOf(songs, "not-local")).toBeUndefined();
    }).pipe(Effect.provide(layer(api)));
  });
});
