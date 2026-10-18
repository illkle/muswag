import {
  albums,
  artists,
  IDLE_LIBRARY_SYNC,
  songs,
  syncState,
  toRow,
  toSongRow,
  type Album,
  type AlbumWithSongsID3,
  type Child,
  type LibrarySyncStatus,
  type RefreshTarget,
  type Song,
  type SyncMode,
} from "@muswag/model";
import { count, eq, inArray, sql } from "drizzle-orm";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Layer, SubscriptionRef } from "effect";

import { SubsonicAPI, WRONG_CREDENTIALS } from "../api/subsonic-api.js";
import { MiniFs, removeCoverFiles } from "../covers/cover-manager.js";
import { Db, write } from "../db/database.js";
import { chunks, STATEMENT_IDS, STATEMENT_ROWS, upsertChanged } from "../db/upsert.js";

export class AlbumWithoutSongs extends Data.TaggedError("AlbumWithoutSongs")<{
  readonly id: string;
  readonly expectedSongCount: number;
  readonly message: string;
}> {}

/** How often a session catches up with the server on its own. */
const SYNC_INTERVAL_MS = 30 * 60_000;

type Progress = LibrarySyncStatus["progress"];
type ReportProgress = (progress: Progress) => Effect.Effect<void>;

/** Downloads the library from the server into the database and keeps it up to date. */
export class LibrarySync extends Context.Service<LibrarySync>()("@muswag/backend/LibrarySync", {
  make: Effect.gen(function* () {
    const context = yield* Effect.context<Db | SubsonicAPI | SqliteMirror | MiniFs>();
    // Syncs belong to the session: closing it, e.g. on logout, interrupts the one running.
    const scope = yield* Effect.scope;
    const db = yield* Db;
    const [saved] = yield* db.select({ lastSyncedAt: syncState.lastSyncedAt }).from(syncState).where(eq(syncState.id, 1));
    const status = yield* SubscriptionRef.make<LibrarySyncStatus>({ ...IDLE_LIBRARY_SYNC, lastSyncedAt: saved?.lastSyncedAt ?? null });
    type Running = { readonly mode: SyncMode; readonly done: Deferred.Deferred<void, SyncError> };
    let current: Running | null = null;

    const reportProgress: ReportProgress = (progress) => SubscriptionRef.update(status, (previous) => ({ ...previous, progress }));

    const run = (running: Running) =>
      syncLibrary(running.mode, reportProgress).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? SubscriptionRef.set(status, { running: null, progress: null, error: exit.value.problem, lastSyncedAt: exit.value.syncedAt })
            : Cause.hasInterruptsOnly(exit.cause)
              ? SubscriptionRef.update(status, (previous) => ({ ...previous, running: null, progress: null, error: null }))
              : // The status has room for one line; the log keeps the rest.
                Effect.logError("Library sync failed", exit.cause).pipe(
                  Effect.andThen(SubscriptionRef.update(status, (previous) => ({ ...previous, running: null, progress: null, error: failureMessage(exit.cause) }))),
                ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.suspend(() => {
            // Before its waiters go on, so that what they ask for next is not taken for this one.
            if (current === running) current = null;
            return Deferred.done(running.done, Exit.asVoid(exit));
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            if (current === running) current = null;
            // Waiters of an interrupted sync are interrupted too; a no-op once it completed.
            return Deferred.interrupt(running.done);
          }),
        ),
        Effect.provide(context),
      );

    /** Runs a sync, or joins the one running when that does as much. */
    const sync = (mode: SyncMode): Effect.Effect<void, SyncError> =>
      Effect.suspend(() => {
        if (current) {
          if (mode === "quick" || current.mode === "full") return Deferred.await(current.done);
          // A full sync asked for during a quick one runs once that one is over, however it ended.
          return Deferred.await(current.done).pipe(Effect.ignore, Effect.andThen(sync(mode)));
        }
        const running: Running = { mode, done: Deferred.makeUnsafe<void, SyncError>() };
        current = running;
        return SubscriptionRef.update(status, (previous) => ({ ...previous, running: mode, progress: null, error: null })).pipe(
          Effect.andThen(Effect.forkIn(run(running), scope)),
          Effect.andThen(Deferred.await(running.done)),
        );
      });

    /** A quick sync, unless one is running or the last ended less than `maxAgeMs` ago. Its failures are in the status. */
    const syncIfStale = (maxAgeMs: number) =>
      Effect.gen(function* () {
        if (current) return;
        const { lastSyncedAt } = yield* SubscriptionRef.get(status);
        if (lastSyncedAt !== null && Date.now() - Date.parse(lastSyncedAt) < maxAgeMs) return;
        yield* sync("quick").pipe(Effect.ignore);
      });

    // Albums added on the server show up without a restart. A quick sync that finds nothing changed costs a few requests.
    yield* Effect.forkIn(Effect.forever(Effect.sleep(SYNC_INTERVAL_MS).pipe(Effect.andThen(syncIfStale(SYNC_INTERVAL_MS)))), scope);

    return {
      status: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
      sync,
      syncIfStale,
      // In the session's scope like a sync, so that logging out stops it before the data is deleted, and it cannot write after.
      refresh: (target: RefreshTarget) => Effect.forkIn(refresh(target).pipe(Effect.provide(context)), scope).pipe(Effect.flatMap(Fiber.join)),
    } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

type SyncError = Effect.Error<ReturnType<typeof syncLibrary>>;

/** What went wrong, as one line. */
const failureMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message || error.name : String(error);
};

const ALBUM_PAGE_SIZE = 500;
const SONG_PAGE_SIZE = 500;
/** Albums whose songs are read before they are written, in one transaction. */
const ALBUM_WRITE_GROUP = 50;
const ALBUM_FETCH_CONCURRENCY = 10;

/**
 * The cover file is the cover manager's. An update keeps it for as long as the server names the same
 * image, and forgets it when the image is another one, so that it is downloaded again.
 */
const keptCoverPath = (table: typeof albums | typeof artists) => sql`CASE WHEN excluded.${sql.identifier(table.coverArt.name)} IS ${table.coverArt} THEN ${table.coverArtPath} END`;
const upsertAlbums = upsertChanged(albums, { keep: ["coverArtPath"], set: { coverArtPath: keptCoverPath(albums) } });
const upsertArtists = upsertChanged(artists, { keep: ["coverArtPath"], set: { coverArtPath: keptCoverPath(artists) } });
const upsertSongs = upsertChanged(songs);

const writeSongs = (rows: ReadonlyArray<Song>) =>
  Db.use((db) =>
    Effect.forEach(
      chunks(rows, STATEMENT_ROWS),
      (chunk) =>
        db
          .insert(songs)
          .values([...chunk])
          .onConflictDoUpdate(upsertSongs),
      { discard: true },
    ),
  );

/** The songs of an album `getAlbum` answered with, which may not be none when the album has songs. */
const songsOf = (album: AlbumWithSongsID3, songCount: number) =>
  (album.song?.length ?? 0) === 0 && songCount > 0
    ? Effect.fail(new AlbumWithoutSongs({ id: album.id, expectedSongCount: songCount, message: `The server lists ${songCount} songs for the album "${album.name}" (${album.id}) but returned none` }))
    : Effect.succeed((album.song ?? []).map(toSongRow));

/** Makes the album's songs the ones given: those it no longer lists go, the rest are written where they changed. */
const replaceAlbumSongs = (albumId: string, rows: ReadonlyArray<Song>) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const keep = new Set(rows.map(({ id }) => id));
    const stale = (yield* db.select({ id: songs.id }).from(songs).where(eq(songs.albumId, albumId))).map(({ id }) => id).filter((id) => !keep.has(id));
    for (const ids of chunks(stale, STATEMENT_IDS)) yield* db.delete(songs).where(inArray(songs.id, [...ids]));
    yield* writeSongs(rows);
  });

/**
 * What the server says of its last scan, or `null` when it does not say or is scanning now. While it
 * says the same, no file has changed.
 */
const serverScan = SubsonicAPI.use((api) => api.getScanStatus).pipe(
  Effect.map(({ scanStatus }) => (scanStatus.scanning || scanStatus.lastScan === undefined ? null : `${scanStatus.lastScan} ${scanStatus.count ?? ""}`)),
  // A server without the method may answer with an error, an HTTP status or something else entirely.
  Effect.catchTags({ SubsonicApiError: () => Effect.succeed(null), SubsonicHttpError: () => Effect.succeed(null), SubsonicDecodeError: () => Effect.succeed(null) }),
);

const syncLibrary = (mode: SyncMode, reportProgress: ReportProgress) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [state] = yield* db.select().from(syncState).where(eq(syncState.id, 1));
    const scan = yield* serverScan;

    yield* syncArtists;
    const { listed, changed, before } = yield* syncAlbumList;

    // While the server has not scanned since the last sync that read every song, the songs of an album
    // that looks the same are the same, and a quick sync reads only the others.
    const readEverySong = mode === "full" || (scan !== null && scan !== (state?.serverScan ?? null));
    // Without search3 a full sync reads every album with getAlbum, and a quick one only those that look changed.
    const failures = readEverySong ? yield* syncEverySong(listed, mode === "full" ? listed : changed, reportProgress) : yield* syncAlbumSongs(changed, reportProgress);
    // An album whose songs could not be read goes back to what it was compared by, so that the next
    // sync finds it changed again, whether or not the server reports its scans.
    yield* write(
      Effect.forEach(
        failures.flatMap(({ id }) => {
          const previous = before.get(id);
          return previous ? [previous] : [];
        }),
        ({ id, ...look }) => db.update(albums).set(look).where(eq(albums.id, id)),
        { discard: true },
      ),
    );

    // Songs of albums that are gone, however they were left behind.
    yield* write(db.delete(songs).where(sql`${songs.albumId} IS NULL OR ${songs.albumId} NOT IN (SELECT ${albums.id} FROM ${albums})`));

    const syncedAt = new Date().toISOString();
    // A scan counts as read only once all its songs are. An album that failed has the next sync read every song again.
    const nextScan = failures.length > 0 ? null : readEverySong ? scan : (state?.serverScan ?? null);
    yield* db
      .insert(syncState)
      .values({ id: 1, serverScan: nextScan, lastSyncedAt: syncedAt })
      .onConflictDoUpdate({ target: syncState.id, set: { serverScan: nextScan, lastSyncedAt: syncedAt } });

    for (const { message } of failures) yield* Effect.logWarning(message);
    const problem = failures.length === 0 ? null : `${failures.length === 1 ? "1 album" : `${failures.length} albums`} could not be synced: ${failures[0]!.message}`;
    return { syncedAt, problem };
  });

const syncArtists = Effect.gen(function* () {
  const api = yield* SubsonicAPI;
  const db = yield* Db;

  const { artists: listing } = yield* api.getArtists();
  const incoming = (listing.index ?? []).flatMap((index) => index.artist ?? []);
  const incomingIds = new Set(incoming.map(({ id }) => id));
  const stale = (yield* db.select({ id: artists.id }).from(artists)).map(({ id }) => id).filter((id) => !incomingIds.has(id));

  const removed = yield* write(
    Effect.gen(function* () {
      for (const rows of chunks(
        incoming.map((artist) => toRow(artists, artist)),
        STATEMENT_ROWS,
      )) {
        yield* db
          .insert(artists)
          .values([...rows])
          .onConflictDoUpdate(upsertArtists);
      }
      return yield* Effect.forEach(chunks(stale, STATEMENT_IDS), (ids) =>
        db
          .delete(artists)
          .where(inArray(artists.id, [...ids]))
          .returning({ cover: artists.coverArtPath }),
      );
    }),
  );
  yield* removeCoverFiles(removed.flat().map(({ cover }) => cover));
});

/** What an album that looks changed is told by. Fields such as its play count change without its songs. */
type AlbumLook = Pick<Album, "songCount" | "duration" | "created" | "name" | "artist">;
const looksTheSame = (before: AlbumLook, after: AlbumLook) =>
  before.songCount === after.songCount && before.duration === after.duration && before.created === after.created && before.name === after.name && before.artist === after.artist;

/**
 * Writes every album the server lists and removes the ones it no longer does. Answers with the albums
 * listed, and those of them whose songs need reading: the new ones, the ones that look changed and the
 * ones whose songs are not all here.
 */
const syncAlbumList = Effect.gen(function* () {
  const api = yield* SubsonicAPI;
  const db = yield* Db;

  const before = new Map(
    (yield* db.select({ id: albums.id, songCount: albums.songCount, duration: albums.duration, created: albums.created, name: albums.name, artist: albums.artist }).from(albums)).map((album) => [
      album.id,
      album,
    ]),
  );
  const songCounts = yield* localSongCounts;

  const listed = new Map<string, Album>();
  // Until a page comes back empty: a server may give fewer albums a page than asked for.
  for (let offset = 0; ;) {
    const { albumList2 } = yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset });
    const page = (albumList2.album ?? []).map((album) => toRow(albums, album));
    // A page of only albums listed before is the end too: a server that ignores the offset answers with the same page again.
    if (!page.some(({ id }) => !listed.has(id))) break;
    offset += page.length;
    yield* write(
      Effect.forEach(
        chunks(page, STATEMENT_ROWS),
        (rows) =>
          db
            .insert(albums)
            .values([...rows])
            .onConflictDoUpdate(upsertAlbums),
        { discard: true },
      ),
    );
    for (const album of page) listed.set(album.id, album);
  }

  const removed = [...before.keys()].filter((id) => !listed.has(id));
  if (removed.length > 0) {
    const gone = yield* write(
      Effect.forEach(chunks(removed, STATEMENT_IDS), (ids) =>
        Effect.gen(function* () {
          const covers = yield* db
            .delete(albums)
            .where(inArray(albums.id, [...ids]))
            .returning({ cover: albums.coverArtPath });
          yield* db.delete(songs).where(inArray(songs.albumId, [...ids]));
          return covers;
        }),
      ),
    );
    yield* removeCoverFiles(gone.flat().map(({ cover }) => cover));
  }

  const changed = [...listed.values()].filter((album) => {
    const previous = before.get(album.id);
    return previous === undefined || !looksTheSame(previous, album) || (songCounts.get(album.id) ?? 0) !== album.songCount;
  });
  return { listed: [...listed.values()], changed, before };
});

const localSongCounts = Db.use((db) => db.select({ albumId: songs.albumId, songs: count() }).from(songs).groupBy(songs.albumId)).pipe(
  Effect.map((rows) => new Map(rows.map(({ albumId, songs }) => [albumId, songs]))),
);

type AlbumFailure = { readonly id: string; readonly message: string };

/**
 * Reads the songs of each album with `getAlbum` and writes them, a group of albums per transaction.
 * Answers with what went wrong with the albums that could not be read: the others are written all the same.
 */
const syncAlbumSongs = (targets: ReadonlyArray<Album>, reportProgress: ReportProgress) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const failures: AlbumFailure[] = [];
    if (targets.length === 0) return failures;

    let done = 0;
    yield* reportProgress({ done, total: targets.length });
    for (const group of chunks(targets, ALBUM_WRITE_GROUP)) {
      const fetched = yield* Effect.forEach(
        group,
        (listed) =>
          api.getAlbum({ id: listed.id }).pipe(
            Effect.flatMap(({ album }) => songsOf(album, listed.songCount)),
            Effect.map((rows) => ({ id: listed.id, rows })),
            // One album the server cannot answer for is left as it was. Refused credentials, or no answer at all, end the sync.
            Effect.catchIf(
              (error) => error._tag === "AlbumWithoutSongs" || error._tag === "SubsonicDecodeError" || (error._tag === "SubsonicApiError" && error.code !== WRONG_CREDENTIALS),
              (error) => Effect.sync(() => void failures.push({ id: listed.id, message: `${error.message} (album ${listed.id})` })).pipe(Effect.as(null)),
            ),
          ),
        { concurrency: ALBUM_FETCH_CONCURRENCY },
      );
      yield* write(Effect.forEach(fetched, (album) => (album ? replaceAlbumSongs(album.id, album.rows) : Effect.void), { discard: true }));
      done += group.length;
      yield* reportProgress({ done, total: targets.length });
    }
    return failures;
  });

/**
 * Reads every song of the library a page at a time through `search3`, which with an empty query
 * matches them all on Navidrome and most servers. Of an album it listed every song of, the songs it
 * did not list are removed. The others, as when the library changed between pages, are read with
 * `getAlbum`, which leaves their songs as they were when it fails. A server that lists no songs that
 * way has the `fallback` albums read with `getAlbum` instead.
 */
const syncEverySong = (listed: ReadonlyArray<Album>, fallback: ReadonlyArray<Album>, reportProgress: ReportProgress) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* Db;
    const albumIds = new Set(listed.map(({ id }) => id));
    const total = listed.reduce((sum, album) => sum + album.songCount, 0);

    const seen = new Set<string>();
    const seenOf = new Map<string, number>();
    const listedSongs = new Set<string>();
    yield* reportProgress({ done: 0, total });
    for (let offset = 0; ;) {
      const result = yield* api.search3({ query: "", artistCount: 0, albumCount: 0, songCount: SONG_PAGE_SIZE, songOffset: offset }).pipe(
        // A server that will not search for nothing answers as one that finds nothing.
        Effect.catchIf(
          (error) => offset === 0 && (error._tag === "SubsonicHttpError" || error._tag === "SubsonicDecodeError" || (error._tag === "SubsonicApiError" && error.code !== WRONG_CREDENTIALS)),
          () => Effect.succeed({ searchResult3: {} as { song?: ReadonlyArray<Child> } }),
        ),
      );
      const page = result.searchResult3.song ?? [];
      // A page of only songs listed before is the end too: a server that ignores the offset answers with the same page again.
      if (!page.some(({ id }) => !listedSongs.has(id))) break;
      for (const { id } of page) listedSongs.add(id);
      offset += page.length;
      // Songs of albums the list did not have would only be removed again.
      const rows = page.filter((song) => song.albumId !== undefined && albumIds.has(song.albumId) && !seen.has(song.id)).map(toSongRow);
      for (const { id, albumId } of rows) {
        seen.add(id);
        seenOf.set(albumId!, (seenOf.get(albumId!) ?? 0) + 1);
      }
      yield* write(writeSongs(rows));
      yield* reportProgress({ done: seen.size, total });
    }

    if (seen.size === 0 && total > 0) return yield* syncAlbumSongs(fallback, reportProgress);

    const complete = new Set(listed.filter((album) => (seenOf.get(album.id) ?? 0) === album.songCount).map(({ id }) => id));
    const stale = (yield* db.select({ id: songs.id, albumId: songs.albumId }).from(songs)).filter(({ id, albumId }) => !seen.has(id) && albumId !== null && complete.has(albumId)).map(({ id }) => id);
    yield* write(Effect.forEach(chunks(stale, STATEMENT_IDS), (ids) => db.delete(songs).where(inArray(songs.id, [...ids])), { discard: true }));

    return yield* syncAlbumSongs(
      listed.filter(({ id }) => !complete.has(id)),
      reportProgress,
    );
  });

/**
 * Reads what a page shows from the server again: an album with all its songs, or the songs of a
 * playlist that are in the library. A playlist's songs of albums the library does not have are left
 * to the sync, which adds them with their album.
 */
const refresh = (target: RefreshTarget) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const api = yield* SubsonicAPI;

    switch (target.type) {
      case "album": {
        const { album } = yield* api.getAlbum({ id: target.id });
        const rows = yield* songsOf(album, album.songCount);
        yield* write(
          Effect.gen(function* () {
            yield* db.insert(albums).values(toRow(albums, album)).onConflictDoUpdate(upsertAlbums);
            yield* replaceAlbumSongs(album.id, rows);
          }),
        );
        break;
      }
      case "playlist": {
        const { playlist } = yield* api.getPlaylist({ id: target.id });
        const entries = playlist.entry ?? [];
        yield* write(
          Effect.gen(function* () {
            const known = new Set<string>();
            for (const ids of chunks([...new Set(entries.map(({ id }) => id))], STATEMENT_IDS)) {
              for (const { id } of yield* db
                .select({ id: songs.id })
                .from(songs)
                .where(inArray(songs.id, [...ids])))
                known.add(id);
            }
            const rows = new Map(entries.filter(({ id }) => known.has(id)).map((song) => [song.id, toSongRow(song)]));
            yield* writeSongs([...rows.values()]);
          }),
        );
        break;
      }
    }
  });
