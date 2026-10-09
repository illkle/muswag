import {
  albums,
  artists,
  IDLE_LIBRARY_SYNC,
  songs,
  syncState,
  toRow,
  toSongRow,
  type AlbumID3,
  type Child,
  type IndexArtist,
  type LibrarySyncStatus,
  type RefreshStatTarget,
  type SyncMode,
} from "@muswag/model";
import { eq, inArray } from "drizzle-orm";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Cause, Context, Data, Deferred, Effect, Exit, Layer, SubscriptionRef } from "effect";

import SubsonicAPI from "../api/subsonic-api.js";
import { Db, write } from "../db/database.js";
import { chunks, excludedSet, STATEMENT_IDS, STATEMENT_ROWS } from "../db/upsert.js";

export class AlbumWithoutSongs extends Data.TaggedError("AlbumWithoutSongs")<{
  readonly id: string;
  readonly expectedSongCount: number;
  readonly message: string;
}> {}

export class SyncAlreadyRunning extends Data.TaggedError("SyncAlreadyRunning")<{
  readonly running: SyncMode;
  readonly message: string;
}> {}

/** Downloads the library from the server into the database and keeps play statistics fresh. */
export class LibrarySync extends Context.Service<LibrarySync>()("@muswag/backend/LibrarySync", {
  make: Effect.gen(function* () {
    const context = yield* Effect.context<Db | SubsonicAPI | SqliteMirror>();
    // Syncs belong to the session: closing it, e.g. on logout, interrupts the one running.
    const scope = yield* Effect.scope;
    const status = yield* SubscriptionRef.make<LibrarySyncStatus>(IDLE_LIBRARY_SYNC);
    type Running = { readonly mode: SyncMode; readonly done: Deferred.Deferred<void, SyncError> };
    let current: Running | null = null;

    const run = (running: Running) =>
      syncLibrary(running.mode).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? SubscriptionRef.set(status, { ...IDLE_LIBRARY_SYNC, lastSyncedAt: new Date().toISOString() })
            : Cause.hasInterruptsOnly(exit.cause)
              ? SubscriptionRef.update(status, (previous) => ({ ...previous, running: null, error: null }))
              : // The status has room for one line; the log keeps the rest.
                Effect.logError("Library sync failed", exit.cause).pipe(
                  Effect.andThen(SubscriptionRef.update(status, (previous) => ({ ...previous, running: null, error: failureMessage(exit.cause) }))),
                ),
        ),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(running.done, exit)),
        Effect.ensuring(
          Effect.suspend(() => {
            if (current === running) current = null;
            // Waiters of an interrupted sync are interrupted too; a no-op once it completed.
            return Deferred.interrupt(running.done);
          }),
        ),
        Effect.provide(context),
      );

    return {
      status: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
      /** Runs a sync, or joins the one already running in the same mode. */
      sync: (mode: SyncMode) =>
        Effect.suspend((): Effect.Effect<void, SyncError | SyncAlreadyRunning> => {
          if (current) {
            if (current.mode !== mode) return Effect.fail(new SyncAlreadyRunning({ running: current.mode, message: `A ${current.mode} sync is already running` }));
            return Deferred.await(current.done);
          }
          const running: Running = { mode, done: Deferred.makeUnsafe<void, SyncError>() };
          current = running;
          return SubscriptionRef.update(status, (previous) => ({ ...previous, running: mode, error: null })).pipe(
            Effect.andThen(Effect.forkIn(run(running), scope)),
            Effect.andThen(Deferred.await(running.done)),
          );
        }),
      refreshStats: (target: RefreshStatTarget) => refreshStats(target).pipe(Effect.provide(context)),
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

const ALBUM_STAT_FIELDS = ["playCount", "played", "starred", "userRating"] as const;
const SONG_STAT_FIELDS = ["playCount", "played", "starred", "userRating", "averageRating", "bookmarkPosition"] as const;
/** Cover fields are maintained by the cover manager, not the server. */
const COVER_FIELDS = ["coverArtPath", "coverArtSourceId"] as const;

const statFields = <K extends string>(source: object, fields: ReadonlyArray<K>) => {
  const values = source as Record<string, unknown>;
  return Object.fromEntries(fields.map((field) => [field, values[field] ?? null])) as Record<K, never>;
};

const syncLibrary = (mode: SyncMode) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const [state] = yield* db.select().from(syncState).where(eq(syncState.id, 1));
    yield* syncArtistsFromIndexes(mode === "quick" ? (state?.indexesLastModified ?? 0) : 0);
    yield* syncAlbumList(mode);
    const now = new Date().toISOString();
    yield* db
      .insert(syncState)
      .values({ id: 1, ...(mode === "full" ? { lastFullSyncAt: now } : { lastQuickSyncAt: now }) })
      .onConflictDoUpdate({ target: syncState.id, set: mode === "full" ? { lastFullSyncAt: now } : { lastQuickSyncAt: now } });
  });

const refreshStats = (target: RefreshStatTarget) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const api = yield* SubsonicAPI;

    const updateSongs = (incoming: ReadonlyArray<Child>) =>
      Effect.forEach(incoming, (song) => db.update(songs).set(statFields(song, SONG_STAT_FIELDS)).where(eq(songs.id, song.id)), { discard: true });

    switch (target.type) {
      case "album": {
        const { album } = yield* api.getAlbum({ id: target.id });
        yield* write(
          Effect.gen(function* () {
            yield* db.update(albums).set(statFields(album, ALBUM_STAT_FIELDS)).where(eq(albums.id, target.id));
            yield* updateSongs(album.song ?? []);
          }),
        );
        break;
      }
      case "playlist": {
        const { playlist } = yield* api.getPlaylist({ id: target.id });
        yield* write(updateSongs(playlist.entry ?? []));
        break;
      }
    }
  });

const syncArtistsFromIndexes = (ifModifiedSince: number) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* Db;

    const { indexes } = yield* api.getIndexes({ ifModifiedSince });
    const incoming: ReadonlyArray<IndexArtist> = (indexes.index ?? []).flatMap((index) => index.artist ?? []);

    // An unchanged or empty index says nothing about which artists are gone.
    if (incoming.length > 0) {
      const incomingIds = new Set(incoming.map(({ id }) => id));
      const stale = (yield* db.select({ id: artists.id }).from(artists)).map(({ id }) => id).filter((id) => !incomingIds.has(id));

      yield* write(
        Effect.gen(function* () {
          for (const rows of chunks(
            incoming.map((artist) => toRow(artists, artist)),
            STATEMENT_ROWS,
          )) {
            yield* db
              .insert(artists)
              .values([...rows])
              .onConflictDoUpdate({ target: artists.id, set: excludedSet(artists, COVER_FIELDS) });
          }
          for (const ids of chunks(stale, STATEMENT_IDS)) yield* db.delete(artists).where(inArray(artists.id, [...ids]));
        }),
      );
    }

    yield* db
      .insert(syncState)
      .values({ id: 1, indexesLastModified: indexes.lastModified })
      .onConflictDoUpdate({ target: syncState.id, set: { indexesLastModified: indexes.lastModified } });
  });

const ALBUM_PAGE_SIZE = 500;

const syncAlbumList = (mode: SyncMode) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* Db;

    const missing = new Set((yield* db.select({ id: albums.id }).from(albums)).map(({ id }) => id));

    for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
      const { albumList2 } = yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset });
      const page = albumList2.album ?? [];
      if (page.length === 0) break;

      const synced = yield* Effect.forEach(page, (album) => syncAlbum(album, mode), { concurrency: 10 });
      for (const id of synced) missing.delete(id);

      if (page.length < ALBUM_PAGE_SIZE) break;
    }

    const removed = [...missing];
    if (removed.length === 0) return;
    yield* write(
      Effect.forEach(
        chunks(removed, STATEMENT_IDS),
        (ids) =>
          Effect.gen(function* () {
            yield* db.delete(albums).where(inArray(albums.id, [...ids]));
            yield* db.delete(songs).where(inArray(songs.albumId, [...ids]));
          }),
        { discard: true },
      ),
    );
  });

const syncAlbum = (incoming: AlbumID3, mode: SyncMode) =>
  Effect.gen(function* () {
    const api = yield* SubsonicAPI;
    const db = yield* Db;

    const row = toRow(albums, incoming);

    if (mode === "quick") {
      const [existing] = yield* db.select().from(albums).where(eq(albums.id, incoming.id));
      const songCount = yield* db.$count(songs, eq(songs.albumId, incoming.id));
      const same =
        existing !== undefined &&
        existing.songCount === row.songCount &&
        existing.duration === row.duration &&
        existing.created === row.created &&
        existing.name === row.name &&
        existing.artist === row.artist &&
        songCount === row.songCount;
      if (same) return incoming.id;
    }

    const { album } = yield* api.getAlbum({ id: incoming.id });
    if (!album.song && incoming.songCount > 0) {
      return yield* new AlbumWithoutSongs({
        id: incoming.id,
        expectedSongCount: incoming.songCount,
        message: `The server lists ${incoming.songCount} songs for the album "${incoming.name}" (${incoming.id}) but returned none`,
      });
    }

    const incomingSongs = (album.song ?? []).map(toSongRow);
    yield* write(
      Effect.gen(function* () {
        yield* db
          .insert(albums)
          .values(row)
          .onConflictDoUpdate({ target: albums.id, set: excludedSet(albums, COVER_FIELDS) });
        // Songs the album no longer lists are gone; the rest are updated in place.
        const keep = new Set(incomingSongs.map(({ id }) => id));
        const stale = (yield* db.select({ id: songs.id }).from(songs).where(eq(songs.albumId, incoming.id))).map(({ id }) => id).filter((id) => !keep.has(id));
        for (const ids of chunks(stale, STATEMENT_IDS)) yield* db.delete(songs).where(inArray(songs.id, [...ids]));
        for (const rows of chunks(incomingSongs, STATEMENT_ROWS)) {
          yield* db
            .insert(songs)
            .values([...rows])
            .onConflictDoUpdate({ target: songs.id, set: excludedSet(songs) });
        }
      }),
    );

    return incoming.id;
  });
