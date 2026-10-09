import {
  ALBUM_ORDER,
  albumOccurrenceKey,
  LIBRARY_ORDERS,
  libraryOccurrenceKey,
  playlistOccurrenceKey,
  playlists,
  queueItems,
  queueResume,
  queueState,
  songs,
  type LibrarySort,
  type QueueItemRow,
  type QueueSourceRef,
  type QueueStateRow,
  type SourceCursor,
  type SourceItem,
  type SourceWindow,
} from "@muswag/model";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, position, write, type Database } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";

/** The columns an order of the library sorts by, all ascending. */
const orderColumns = (sort: LibrarySort) => LIBRARY_ORDERS[sort].map((key) => songs[key]);

// ---- Queue sources ----
// A source is read as a whole in one transaction: where its cursor is and the occurrences around it
// come from the same contents, so they always agree.

type Reads = Pick<Database, "select" | "$count">;
const found = (index: number) => (index < 0 ? null : index);

/** An album's songs in `ALBUM_ORDER`, which is how the album page lists them. Albums are small, so the whole album is read. */
const openAlbum = (db: Reads, albumId: string, key: string | null) =>
  db
    .select()
    .from(songs)
    .where(eq(songs.albumId, albumId))
    .orderBy(...ALBUM_ORDER.map((column) => asc(songs[column])))
    .pipe(
      Effect.map((rows) => {
        const items = rows.map((track, offset): SourceItem => ({ key: albumOccurrenceKey(albumId, track.id), offset, track }));
        return { length: items.length, offset: found(items.findIndex((item) => item.key === key)), read: (start: number, end: number) => Effect.succeed(items.slice(start, end)) };
      }),
    );

/** A playlist's entries in order. An entry whose song the library does not have keeps its offset but is left out of what is read. */
const openPlaylist = (db: Reads, playlistId: string, key: string | null) =>
  db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .pipe(
      Effect.map(([record]) => {
        const entries = record?.local?.entries ?? [];
        return {
          length: entries.length,
          offset: found(entries.findIndex(({ id }) => playlistOccurrenceKey(playlistId, id) === key)),
          read: (start: number, end: number) => {
            const slice = entries.slice(start, end);
            return db
              .select()
              .from(songs)
              .where(inArray(songs.id, [...new Set(slice.map(({ songId }) => songId))]))
              .pipe(
                Effect.map((rows) => {
                  const byId = new Map(rows.map((song) => [song.id, song]));
                  return slice.flatMap((entry, index): SourceItem[] => {
                    const track = byId.get(entry.songId);
                    return track ? [{ key: playlistOccurrenceKey(playlistId, entry.id), offset: start + index, track }] : [];
                  });
                }),
              );
          },
        };
      }),
    );

/**
 * Every song of the library in one of its orders. The library is too large to load, so the database
 * does the ordering, and a song is found by counting those before it.
 */
const openLibrary = (db: Reads, sort: LibrarySort, key: string | null) =>
  Effect.gen(function* () {
    const prefix = libraryOccurrenceKey("");
    const [song] = key?.startsWith(prefix)
      ? yield* db
          .select()
          .from(songs)
          .where(eq(songs.id, key.slice(prefix.length)))
      : [];
    // A row value comparison, which SQLite answers from the index the order sorts by.
    const columns = sql.join(orderColumns(sort), sql`, `);
    const values = sql.join(
      LIBRARY_ORDERS[sort].map((column) => sql`${song?.[column]}`),
      sql`, `,
    );
    return {
      length: yield* db.$count(songs),
      offset: song ? yield* db.$count(songs, sql`(${columns}) < (${values})`) : null,
      read: (start: number, end: number) =>
        db
          .select()
          .from(songs)
          .orderBy(...orderColumns(sort).map((column) => asc(column)))
          .limit(end - start)
          .offset(start)
          .pipe(Effect.map((rows) => rows.map((track, index): SourceItem => ({ key: libraryOccurrenceKey(track.id), offset: start + index, track })))),
    };
  });

const openSource = (db: Reads, ref: QueueSourceRef, key: string | null) => {
  switch (ref.type) {
    case "album":
      return openAlbum(db, ref.albumId, key);
    case "playlist":
      return openPlaylist(db, ref.playlistId, key);
    case "library":
      return openLibrary(db, ref.sort, key);
  }
};

/** Reads main itself needs, such as the playback queue's sources. */
export const LibraryQueries = {
  songsByIds: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      Effect.forEach(chunks([...new Set(ids)], STATEMENT_IDS), (chunk) =>
        db
          .select()
          .from(songs)
          .where(inArray(songs.id, [...chunk])),
      ),
    ).pipe(Effect.map((pages) => pages.flat())),

  /**
   * The part of a queue source around `at`: the occurrence `at.key` where the source has it, and
   * otherwise the gap at `at.offset`, which is where that occurrence was. `null` when the source has
   * neither. Up to `behind` occurrences come before the cursor and up to `ahead` after it.
   */
  sourceWindow: (ref: QueueSourceRef, at: { readonly key: string | null; readonly offset: number | null }, size: { readonly behind: number; readonly ahead: number }) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const source = yield* openSource(tx, ref, at.key);
          const cursor: SourceCursor | null =
            at.key !== null && source.offset !== null ? { type: "item", key: at.key, offset: source.offset } : at.offset !== null ? { type: "gap", offset: at.offset } : null;
          if (!cursor) return null;
          // A gap holds no occurrence, so what follows starts at its offset.
          const after = cursor.type === "item" ? cursor.offset + 1 : cursor.offset;
          // A read can come back short, where a playlist has entries that cannot be played: reading
          // goes on until the window is full or the source ends.
          const next: SourceItem[] = [];
          let end = after;
          while (next.length < size.ahead && end < source.length) {
            const to = end + size.ahead - next.length;
            next.push(...(yield* source.read(end, to)));
            end = to;
          }
          const previous: SourceItem[] = [];
          // A gap may be past the end of a source that shrank.
          let start = Math.min(cursor.offset, source.length);
          while (previous.length < size.behind && start > 0) {
            const from = Math.max(0, start - (size.behind - previous.length));
            previous.unshift(...(yield* source.read(from, start)));
            start = from;
          }
          const [current = null] = cursor.type === "item" ? yield* source.read(cursor.offset, after) : [];
          const window: SourceWindow = { cursor, previous, current, next, hasMore: end < source.length };
          return window;
        }),
      ),
    ),

  /** The playback queue as stored: its single state row, if any, its occurrences, and where playback resumes. */
  loadQueue: Db.use((db) =>
    Effect.all({
      state: db
        .select()
        .from(queueState)
        .where(eq(queueState.id, 1))
        .pipe(Effect.map((rows) => rows[0] ?? null)),
      items: db.select().from(queueItems),
      resumePositionSeconds: db
        .select()
        .from(queueResume)
        .where(eq(queueResume.id, 1))
        .pipe(Effect.map((rows) => rows[0]?.positionSeconds ?? 0)),
    }),
  ),

  /**
   * Applies a change to the stored queue in one write; `null` leaves the state row or the resume
   * position as it is. The resume position is in a table renderers do not mirror, so a change of it
   * alone sends them nothing.
   */
  writeQueue: (change: { readonly upsert: ReadonlyArray<QueueItemRow>; readonly remove: ReadonlyArray<string>; readonly state: QueueStateRow | null; readonly resumePositionSeconds: number | null }) =>
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
          const positionSeconds = change.resumePositionSeconds;
          if (positionSeconds !== null) yield* db.insert(queueResume).values({ id: 1, positionSeconds }).onConflictDoUpdate({ target: queueResume.id, set: { positionSeconds } });
        }),
      ).pipe(Effect.andThen(position)),
    ),

  clearQueue: write(Db.use((db) => Effect.all([db.delete(queueItems), db.delete(queueState), db.delete(queueResume)], { discard: true }))),
};
