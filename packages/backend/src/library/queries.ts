import {
  ALBUM_ORDER,
  albumOccurrenceKey,
  albums,
  ARTIST_ALBUM_ORDER,
  artistOccurrenceKey,
  artists,
  LIBRARY_ORDERS,
  libraryOccurrenceKey,
  MAIN_ONLY_SONG_COLUMNS,
  playlistOccurrenceKey,
  playlists,
  queueItems,
  queueResume,
  queueState,
  songs,
  sortKey,
  type AlbumPage,
  type AlbumPageRequest,
  type ArtistAppearances,
  type LibrarySort,
  type QueueItemRow,
  type QueueSourceRef,
  type QueueStateRow,
  type SearchHit,
  type SearchResult,
  type SongPage,
  type SongPageRequest,
  type SongRange,
  type SourceCursor,
  type SourceItem,
  type SourceWindow,
} from "@muswag/model";
import { asc, desc, eq, getTableColumns, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { Db, position, write, type Database } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";

/** The columns an order of the library sorts by, all ascending. */
const orderColumns = (sort: LibrarySort) => LIBRARY_ORDERS[sort].map((key) => songs[key]);

/** Where a song is in an order: its values of the order's columns. `undefined` when the library does not have it. */
const placeOf = (db: Pick<Database, "select">, sort: LibrarySort, id: string) =>
  db
    .select({ key: songs[LIBRARY_ORDERS[sort][0]], id: songs.id })
    .from(songs)
    .where(eq(songs.id, id))
    .pipe(Effect.map(([place]) => place));

/**
 * The songs before or after a place in an order, as a row value comparison, which SQLite answers from
 * the index the order sorts by. Spelled out as `key < ? OR (key = ? AND id < ?)` it reads every song.
 */
const beside = (sort: LibrarySort, operator: "<" | ">", place: { readonly key: string; readonly id: string }) =>
  sql`(${sql.join(orderColumns(sort), sql`, `)}) ${sql.raw(operator)} (${place.key}, ${place.id})`;

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

/** The songs of an artist's albums, album after album, which is how the artists page lists them. A discography is small enough to read whole. */
const openArtist = (db: Reads, artistId: string, key: string | null) =>
  db
    .select({ track: songs })
    .from(songs)
    .innerJoin(albums, eq(albums.id, songs.albumId))
    .where(eq(albums.artistId, artistId))
    .orderBy(
      // SQLite puts nulls first going up and last going down, as the page asks TanStack DB to.
      ...ARTIST_ALBUM_ORDER.map(({ column, direction }) => (direction === "desc" ? desc : asc)(albums[column])),
      ...ALBUM_ORDER.map((column) => asc(songs[column])),
    )
    .pipe(
      Effect.map((rows) => {
        const items = rows.map(({ track }, offset): SourceItem => ({ key: artistOccurrenceKey(artistId, track.id), offset, track }));
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
    const place = key?.startsWith(prefix) ? yield* placeOf(db, sort, key.slice(prefix.length)) : undefined;
    return {
      length: yield* db.$count(songs),
      offset: place ? yield* db.$count(songs, beside(sort, "<", place)) : null,
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
    case "artist":
      return openArtist(db, ref.artistId, key);
    case "playlist":
      return openPlaylist(db, ref.playlistId, key);
    case "library":
      return openLibrary(db, ref.sort, key);
  }
};

const MAIN_ONLY = new Set<string>(MAIN_ONLY_SONG_COLUMNS);
/** The columns of a song that renderers mirror. */
const LIBRARY_SONG_COLUMNS = Object.fromEntries(Object.entries(getTableColumns(songs)).filter(([name]) => !MAIN_ONLY.has(name))) as Omit<
  (typeof songs)["_"]["columns"],
  (typeof MAIN_ONLY_SONG_COLUMNS)[number]
>;

/** Ranges in order, those that overlap or meet made one, empty ones left out. */
const merged = (ranges: ReadonlyArray<SongRange>) =>
  [...ranges]
    .filter(({ start, end }) => start < end)
    .sort((left, right) => left.start - right.start)
    .reduce<Array<{ start: number; end: number }>>((result, { start, end }) => {
      const last = result.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else result.push({ start, end });
      return result;
    }, []);

/** Reads main itself needs, such as the playback queue's sources, and the songs and albums lists, which renderers read by the page. */
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
   * A page of the songs list in an order, songs as renderers mirror them, and how many songs there are
   * when `withTotal`; both from one transaction, so they agree. A page after or before a song is found
   * from where that song is through the order's index, and is `null` when the library no longer has it.
   */
  songPage: (sort: LibrarySort, request: SongPageRequest, withTotal: boolean) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const columns = orderColumns(sort);
          const select = () => tx.select(LIBRARY_SONG_COLUMNS).from(songs);
          let rows;
          if ("offset" in request) {
            rows = yield* select()
              .orderBy(...columns.map((column) => asc(column)))
              .limit(request.limit)
              .offset(request.offset);
          } else {
            const place = yield* placeOf(tx, sort, "after" in request ? request.after : request.before);
            if (!place) return null;
            // The songs before a place are read from it backwards, so the nearest are the ones the limit keeps.
            rows =
              "after" in request
                ? yield* select()
                    .where(beside(sort, ">", place))
                    .orderBy(...columns.map((column) => asc(column)))
                    .limit(request.limit)
                : (yield* select()
                    .where(beside(sort, "<", place))
                    .orderBy(...columns.map((column) => desc(column)))
                    .limit(request.limit)).reverse();
          }
          const page: SongPage = { songs: rows, total: withTotal ? yield* tx.$count(songs) : null };
          return page;
        }),
      ),
    ),

  /** The ids of the songs at `ranges` of the songs list in an order, in list order, from one transaction. Overlapping ranges read their songs once. */
  songIds: (sort: LibrarySort, ranges: ReadonlyArray<SongRange>) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.forEach(merged(ranges), ({ start, end }) =>
          tx
            .select({ id: songs.id })
            .from(songs)
            .orderBy(...orderColumns(sort).map((column) => asc(column)))
            .limit(end - start)
            .offset(start),
        ),
      ),
    ).pipe(Effect.map((pages) => pages.flat().map(({ id }) => id))),

  /**
   * Where songs whose title, artist or album, as the order goes by, starts at or after `text` begin:
   * how many come before. The key of each order begins with the sort key of what it goes by, so one
   * comparison with the sort key of the text answers it for all of them.
   */
  songPosition: (sort: LibrarySort, text: string) => Db.use((db) => db.$count(songs, lt(songs[LIBRARY_ORDERS[sort][0]], sortKey(text)))),

  /**
   * A page of the albums page, newest first, those without a year last and albums of a year by id,
   * which the `albums_year` index holds in that order; with how many albums there are when
   * `withTotal`, from the same transaction.
   */
  albumPage: (request: AlbumPageRequest, withTotal: boolean) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx.select().from(albums).orderBy(desc(albums.year), asc(albums.id)).limit(request.limit).offset(request.offset);
          const page: AlbumPage = { albums: rows, total: withTotal ? yield* tx.$count(albums) : null };
          return page;
        }),
      ),
    ),

  /** The ids of the artists with an album of their own, which are those the artists page lists. */
  artistsWithAlbums: () =>
    Db.use((db) => db.selectDistinct({ artistId: albums.artistId }).from(albums).where(isNotNull(albums.artistId))).pipe(
      Effect.map((rows) => rows.flatMap(({ artistId }) => (artistId === null ? [] : [artistId]))),
    ),

  /** The cover art ids of the albums in `ids` that the library has, which a song shows its album's cover by. */
  albumCoverArts: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      Effect.forEach(chunks([...new Set(ids)], STATEMENT_IDS), (chunk) =>
        db
          .select({ id: albums.id, coverArt: albums.coverArt })
          .from(albums)
          .where(inArray(albums.id, [...chunk])),
      ),
    ).pipe(Effect.map((pages) => pages.flat())),

  /** The songs of the albums `ids`, album after album in that order, each album's in `ALBUM_ORDER`, as its page lists them. */
  albumSongIds: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      Effect.forEach(chunks([...new Set(ids)], STATEMENT_IDS), (chunk) =>
        db
          .select({ id: songs.id, albumId: songs.albumId })
          .from(songs)
          .where(inArray(songs.albumId, [...chunk]))
          .orderBy(...ALBUM_ORDER.map((column) => asc(songs[column]))),
      ),
    ).pipe(
      Effect.map((pages) => {
        const byAlbum = new Map<string | null, string[]>();
        for (const { id, albumId } of pages.flat()) {
          const album = byAlbum.get(albumId);
          if (album) album.push(id);
          else byAlbum.set(albumId, [id]);
        }
        return ids.flatMap((id) => byAlbum.get(id) ?? []);
      }),
    ),

  /** The rows of what a search found, in the order it found them, leaving out any that have gone since. Songs come as renderers mirror them. */
  searchResults: (hits: ReadonlyArray<SearchHit>) =>
    Db.use((db) => {
      const idsOf = (type: SearchHit["type"]) => hits.flatMap((hit) => (hit.type === type ? [hit.id] : []));
      const [songIds, albumIds, artistIds] = [idsOf("song"), idsOf("album"), idsOf("artist")];
      return Effect.all([
        songIds.length ? db.select(LIBRARY_SONG_COLUMNS).from(songs).where(inArray(songs.id, songIds)) : Effect.succeed([]),
        albumIds.length ? db.select().from(albums).where(inArray(albums.id, albumIds)) : Effect.succeed([]),
        artistIds.length ? db.select().from(artists).where(inArray(artists.id, artistIds)) : Effect.succeed([]),
      ]);
    }).pipe(
      Effect.map(([songRows, albumRows, artistRows]) => {
        const found = new Map<string, SearchResult>([
          ...songRows.map((song) => [`song:${song.id}`, { type: "song", id: song.id, song }] as const),
          ...albumRows.map((album) => [`album:${album.id}`, { type: "album", id: album.id, album }] as const),
          ...artistRows.map((artist) => [`artist:${artist.id}`, { type: "artist", id: artist.id, artist }] as const),
        ]);
        return hits.flatMap((hit) => found.get(`${hit.type}:${hit.id}`) ?? []);
      }),
    ),

  /**
   * Where `artistId` appears on other artists' albums: the albums with a song that credits it. The
   * credits are JSON on each song, so this reads every song, which SQLite does far faster than a page.
   */
  artistAppearances: (artistId: string) =>
    Db.use((db) =>
      db.all<{ albumId: string; name: string | null }>(sql`
        SELECT DISTINCT ${songs.albumId} AS albumId, json_extract(credit.value, '$.name') AS name
        FROM ${songs}
        JOIN ${albums} ON ${albums.id} = ${songs.albumId}
        JOIN json_each(${songs.artists}) AS credit
        WHERE json_extract(credit.value, '$.id') = ${artistId} AND ${albums.artistId} IS NOT ${artistId}
      `),
    ).pipe(Effect.map((rows): ArtistAppearances => ({ albumIds: [...new Set(rows.map(({ albumId }) => albumId))], name: rows.find(({ name }) => name)?.name ?? null }))),

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
