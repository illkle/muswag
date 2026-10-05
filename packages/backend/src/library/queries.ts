import { LIBRARY_ORDERS, playlists, queueItems, queueState, songs, type LibrarySort, type QueueItemRow, type QueueStateRow } from "@muswag/model";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, position, write } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";

/** The columns an order of the library sorts by, all ascending. */
const orderColumns = (sort: LibrarySort) => LIBRARY_ORDERS[sort].map((key) => songs[key]);

/** Reads main itself needs, such as the playback queue's sources. */
export const LibraryQueries = {
  playlist: (playlistId: string) => Db.use((db) => db.select().from(playlists).where(eq(playlists.id, playlistId))).pipe(Effect.map((rows) => rows[0])),

  songsByIds: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      Effect.forEach(chunks([...new Set(ids)], STATEMENT_IDS), (chunk) =>
        db
          .select()
          .from(songs)
          .where(inArray(songs.id, [...chunk])),
      ),
    ).pipe(Effect.map((pages) => pages.flat())),

  /** The album's songs in playback order. */
  albumSongs: (albumId: string) => Db.use((db) => db.select().from(songs).where(eq(songs.albumId, albumId)).orderBy(asc(songs.discNumber), asc(songs.track), asc(songs.id))),

  /** How many songs the library has. */
  librarySize: Db.use((db) => db.$count(songs)),

  /** The songs at `start` up to `end` of the library in the given order, and the size of the library they were read from. */
  librarySongs: (sort: LibrarySort, start: number, end: number) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.all({
          size: tx.$count(songs),
          songs: tx
            .select()
            .from(songs)
            .orderBy(...orderColumns(sort).map((column) => asc(column)))
            .limit(end - start)
            .offset(start),
        }),
      ),
    ),

  /** How many songs come before `songId` in the given order of the library, or `null` when it is not in the library. */
  libraryOffset: (sort: LibrarySort, songId: string) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const size = yield* tx.$count(songs);
          const [song] = yield* tx.select().from(songs).where(eq(songs.id, songId));
          if (!song) return { size, offset: null };
          // A row value comparison, which SQLite answers from the index the order sorts by.
          const columns = sql.join(orderColumns(sort), sql`, `);
          const values = sql.join(
            LIBRARY_ORDERS[sort].map((key) => sql`${song[key]}`),
            sql`, `,
          );
          return { size, offset: yield* tx.$count(songs, sql`(${columns}) < (${values})`) };
        }),
      ),
    ),

  /** The playback queue as stored: its single state row, if any, and its occurrences. */
  loadQueue: Db.use((db) =>
    Effect.all({
      state: db
        .select()
        .from(queueState)
        .where(eq(queueState.id, 1))
        .pipe(Effect.map((rows) => rows[0] ?? null)),
      items: db.select().from(queueItems),
    }),
  ),

  /** Applies a change to the stored queue in one write, and returns the position renderers can await. */
  writeQueue: (change: { readonly upsert: ReadonlyArray<QueueItemRow>; readonly remove: ReadonlyArray<string>; readonly state: QueueStateRow | null }) =>
    write(
      Db.use((db) =>
        Effect.gen(function* () {
          for (const chunk of chunks(change.remove, STATEMENT_IDS)) yield* db.delete(queueItems).where(inArray(queueItems.key, [...chunk]));
          for (const row of change.upsert) {
            yield* db
              .insert(queueItems)
              .values(row)
              .onConflictDoUpdate({ target: queueItems.key, set: { list: row.list, position: row.position, track: row.track } });
          }
          if (change.state) yield* db.insert(queueState).values(change.state).onConflictDoUpdate({ target: queueState.id, set: change.state });
        }),
      ).pipe(Effect.andThen(position)),
    ),

  clearQueue: write(Db.use((db) => Effect.all([db.delete(queueItems), db.delete(queueState)], { discard: true }))),
};
