import {
  ALBUM_ORDER,
  albumOccurrenceKey,
  albums,
  ARTIST_ALBUM_ORDER,
  artistOccurrenceKey,
  artists,
  LIBRARY_ORDERS,
  libraryOccurrenceKey,
  librarySortParts,
  MAIN_ONLY_ALBUM_COLUMNS,
  MAIN_ONLY_ARTIST_COLUMNS,
  MAIN_ONLY_SONG_COLUMNS,
  playlistOccurrenceKey,
  playlists,
  queueItems,
  queueResume,
  queueState,
  songs,
  sortKey,
  type AlbumDetail,
  type AlbumPage,
  type AlbumPageRequest,
  type AlbumSort,
  type ArtistAppearances,
  type ArtistIndex,
  type ArtistDetail,
  type Discography,
  type PlaylistDetail,
  type PlaylistRow,
  type LibrarySort,
  type QueueItemRow,
  type QueueSourceRef,
  type QueueStateRow,
  type PlaylistSearchResult,
  type SearchHit,
  type SearchResult,
  type SongPage,
  type SongPageRequest,
  type SongRange,
  type SourceCursor,
  type SourceItem,
  type SourceWindow,
} from "@muswag/model";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, lt, not, notInArray, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { Db, type Database } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";

/** The columns an order of the library sorts by, whichever way it goes. */
const orderColumns = (sort: LibrarySort) => LIBRARY_ORDERS[librarySortParts(sort).by].map((key) => songs[key]);

/** The library in an order, or `backwards` against it. SQLite reads the order's index either way. */
const ordered = (sort: LibrarySort, backwards = false) => orderColumns(sort).map((column) => (librarySortParts(sort).descending !== backwards ? desc : asc)(column));

/** Where a song is in an order: its values of the order's columns. `undefined` when the library does not have it. */
const placeOf = (db: Pick<Database, "select">, sort: LibrarySort, id: string) =>
  db
    .select({ key: songs[LIBRARY_ORDERS[librarySortParts(sort).by][0]], id: songs.id })
    .from(songs)
    .where(eq(songs.id, id))
    .pipe(Effect.map(([place]) => place));

/**
 * The songs before or after a place in an order, as a row value comparison, which SQLite answers from
 * the index the order sorts by. Spelled out as `key < ? OR (key = ? AND id < ?)` it reads every song.
 */
const beside = (sort: LibrarySort, side: "before" | "after", place: { readonly key: string; readonly id: string }) =>
  sql`(${sql.join(orderColumns(sort), sql`, `)}) ${sql.raw((side === "before") !== librarySortParts(sort).descending ? "<" : ">")} (${place.key}, ${place.id})`;

/** After every character a sort key has, so text followed by it comes after every key that starts with the text. */
const PAST_KEYS = "\u{10FFFF}";

/**
 * The albums page in each of its orders, by id where the rest ties. SQLite puts nulls first going up
 * and last going down; albums without a year go last either way. An album without an artist has an
 * empty sort key, which comes first going up and last going down.
 */
const ALBUM_ORDERS: Record<AlbumSort, () => SQL[]> = {
  "year-desc": () => [desc(albums.year), asc(albums.id)],
  year: () => [sql`${albums.year} ASC NULLS LAST`, asc(albums.id)],
  artist: () => [asc(albums.artistSortKey), desc(albums.year), asc(albums.id)],
  "artist-desc": () => [desc(albums.artistSortKey), desc(albums.year), asc(albums.id)],
  added: () => [desc(albums.created), asc(albums.id)],
};

/**
 * Whether `billed`, a credit in `artists` of an album, is a main artist of it. `artistId` on an album holds
 * only the first of those, and `artists` also those featured on its songs, so the others are the ones
 * `displayArtist` names as well, which Navidrome joins with " • ".
 */
const isMainArtist = sql`instr(' • ' || ${albums.displayArtist} || ' • ', ' • ' || json_extract(billed.value, '$.name') || ' • ') > 0`;

/** The albums that are `artistId`'s own. A set of ids read once, so that a query joining songs finds their songs by album and does not take apart an album for each song. */
const ownAlbum = (artistId: string) =>
  sql`${albums.id} IN (
    SELECT ${albums.id} FROM ${albums} WHERE ${albums.artistId} = ${artistId}
    UNION
    SELECT ${albums.id} FROM ${albums}, json_each(${albums.artists}) AS billed WHERE json_extract(billed.value, '$.id') = ${artistId} AND ${isMainArtist}
  )`;

/**
 * The songs that credit `artistId` on albums that are not its own. The credits are JSON on each song,
 * so this reads every song, which SQLite does far faster than a page. Only the songs whose credits hold
 * the id as JSON writes it, quoted, are taken apart: the few that might credit it. JSON.stringify wrote
 * the column, and writes the id the same way here.
 */
const creditedOnOthers = (artistId: string) =>
  and(
    sql`instr(${songs.artists}, ${JSON.stringify(artistId)}) > 0`,
    sql`EXISTS (SELECT 1 FROM json_each(${songs.artists}) AS credit WHERE json_extract(credit.value, '$.id') = ${artistId})`,
    not(ownAlbum(artistId)),
  );

/** An artist's albums in `ARTIST_ALBUM_ORDER`. SQLite puts nulls first going up and last going down, as the order asks. */
const artistAlbumOrder = () => ARTIST_ALBUM_ORDER.map(({ column, direction }) => (direction === "desc" ? desc : asc)(albums[column]));
/** An album's songs in `ALBUM_ORDER`. */
const albumSongOrder = () => ALBUM_ORDER.map((column) => asc(songs[column]));

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
    .orderBy(...albumSongOrder())
    .pipe(
      Effect.map((rows) => {
        const items = rows.map((track, offset): SourceItem => ({ key: albumOccurrenceKey(albumId, track.id), offset, track }));
        return { length: items.length, offset: found(items.findIndex((item) => item.key === key)), read: (start: number, end: number) => Effect.succeed(items.slice(start, end)) };
      }),
    );

/**
 * The songs of an artist's albums, album after album, then its songs on others' albums, which is how
 * the artists page lists them. A discography is small enough to read whole.
 */
const openArtist = (db: Reads, artistId: string, key: string | null) =>
  Effect.forEach([ownAlbum(artistId), creditedOnOthers(artistId)], (where) =>
    db
      .select({ track: songs })
      .from(songs)
      .innerJoin(albums, eq(albums.id, songs.albumId))
      .where(where)
      .orderBy(...artistAlbumOrder(), ...albumSongOrder()),
  ).pipe(
    Effect.map((reads) => {
      const items = reads.flat().map(({ track }, offset): SourceItem => ({ key: artistOccurrenceKey(artistId, track.id), offset, track }));
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
      offset: place ? yield* db.$count(songs, beside(sort, "before", place)) : null,
      read: (start: number, end: number) =>
        db
          .select()
          .from(songs)
          .orderBy(...ordered(sort))
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
/** The columns of a song that renderers get. */
const LIBRARY_SONG_COLUMNS = Object.fromEntries(Object.entries(getTableColumns(songs)).filter(([name]) => !MAIN_ONLY.has(name))) as Omit<
  (typeof songs)["_"]["columns"],
  (typeof MAIN_ONLY_SONG_COLUMNS)[number]
>;

const MAIN_ONLY_ALBUM = new Set<string>(MAIN_ONLY_ALBUM_COLUMNS);
/** The columns of an album that renderers get. */
const LIBRARY_ALBUM_COLUMNS = Object.fromEntries(Object.entries(getTableColumns(albums)).filter(([name]) => !MAIN_ONLY_ALBUM.has(name))) as Omit<
  (typeof albums)["_"]["columns"],
  (typeof MAIN_ONLY_ALBUM_COLUMNS)[number]
>;

const MAIN_ONLY_ARTIST = new Set<string>(MAIN_ONLY_ARTIST_COLUMNS);
/** The columns of an artist that renderers get. */
const LIBRARY_ARTIST_COLUMNS = Object.fromEntries(Object.entries(getTableColumns(artists)).filter(([name]) => !MAIN_ONLY_ARTIST.has(name))) as Omit<
  (typeof artists)["_"]["columns"],
  (typeof MAIN_ONLY_ARTIST_COLUMNS)[number]
>;

/** `column IN` the values of `ids`, as one parameter however many there are: SQLite caps the parameters of a statement. */
const inIds = (column: SQLiteColumn, ids: ReadonlyArray<string>) => sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

/** How many songs of a playlist its artwork is looked for among: the first four albums are nearly always in them. */
const ART_SONGS = 50;

/** The playlists of `ids` as a search shows them, but those awaiting deletion on the server: with the first four albums they draw on, for their artwork. */
const playlistResults = (db: Database, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ id: playlists.id, local: playlists.local })
      .from(playlists)
      .where(and(inArray(playlists.id, [...ids]), isNotNull(playlists.local)));
    const firstSongs = new Map(rows.map(({ id, local }) => [id, local!.entries.slice(0, ART_SONGS).map(({ songId }) => songId)]));
    const songIds = [...new Set([...firstSongs.values()].flat())];
    const albumOf = new Map(songIds.length ? (yield* db.select({ id: songs.id, albumId: songs.albumId }).from(songs).where(inIds(songs.id, songIds))).map(({ id, albumId }) => [id, albumId]) : []);
    return rows.map(({ id, local }): PlaylistSearchResult => ({
      id,
      name: local!.name,
      songCount: local!.entries.length,
      owner: local!.owner ?? null,
      albumIds: [...new Set(firstSongs.get(id)!.flatMap((songId) => albumOf.get(songId) ?? []))].slice(0, 4),
    }));
  });

/** The songs of `ids` that the library has, as renderers get them, in no particular order. */
const librarySongsIn = (db: Pick<Database, "select">, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? Effect.succeed([])
    : db
        .select(LIBRARY_SONG_COLUMNS)
        .from(songs)
        .where(inIds(songs.id, [...new Set(ids)]));

/** Artists' names as the artists page lists them: by the letters, whatever their case or accents, and numbers by their value. */
const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

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

/** Reads main itself needs, such as the playback queue's sources, and what renderers read through main's commands. */
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
   * A page of the songs list in an order, songs as renderers get them, and how many songs there are
   * when `withTotal`; both from one transaction, so they agree. A page after or before a song is found
   * from where that song is through the order's index, and is `null` when the library no longer has it.
   */
  songPage: (sort: LibrarySort, request: SongPageRequest, withTotal: boolean) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const select = () => tx.select(LIBRARY_SONG_COLUMNS).from(songs);
          let rows;
          if ("offset" in request) {
            rows = yield* select()
              .orderBy(...ordered(sort))
              .limit(request.limit)
              .offset(request.offset);
          } else {
            const place = yield* placeOf(tx, sort, "after" in request ? request.after : request.before);
            if (!place) return null;
            // The songs before a place are read from it backwards, so the nearest are the ones the limit keeps.
            rows =
              "after" in request
                ? yield* select()
                    .where(beside(sort, "after", place))
                    .orderBy(...ordered(sort))
                    .limit(request.limit)
                : (yield* select()
                    .where(beside(sort, "before", place))
                    .orderBy(...ordered(sort, true))
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
            .orderBy(...ordered(sort))
            .limit(end - start)
            .offset(start),
        ),
      ),
    ).pipe(Effect.map((pages) => pages.flat().map(({ id }) => id))),

  /**
   * Where songs whose title, artist or album, as the order goes by, starts at or after `text` begin:
   * how many come before. The key of each order begins with the sort key of what it goes by, so one
   * comparison with the sort key of the text answers it for all of them. Going down, those before are
   * the songs whose key comes after every key that starts with the text.
   */
  songPosition: (sort: LibrarySort, text: string) => {
    const { by, descending } = librarySortParts(sort);
    const key = songs[LIBRARY_ORDERS[by][0]];
    return Db.use((db) => db.$count(songs, descending ? gt(key, sortKey(text) + PAST_KEYS) : lt(key, sortKey(text))));
  },

  /**
   * A page of the albums page in `sort` order; with how many albums there are when `withTotal`, from
   * the same transaction. Newest first, the `albums_year` index holds them in order.
   */
  albumPage: (sort: AlbumSort, request: AlbumPageRequest, withTotal: boolean) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .select()
            .from(albums)
            .orderBy(...ALBUM_ORDERS[sort]())
            .limit(request.limit)
            .offset(request.offset);
          const page: AlbumPage = { albums: rows, total: withTotal ? yield* tx.$count(albums) : null };
          return page;
        }),
      ),
    ),

  /** The artists the artists page lists, by name: those with an album of their own, and the rest, which the server lists for their credits on others' albums. */
  artistIndex: () =>
    Db.use((db) => {
      const owners = sql`(
        SELECT ${albums.artistId} FROM ${albums} WHERE ${albums.artistId} IS NOT NULL
        UNION
        SELECT json_extract(billed.value, '$.id') FROM ${albums}, json_each(${albums.artists}) AS billed
        WHERE json_extract(billed.value, '$.id') IS NOT NULL AND ${isMainArtist}
      )`;
      return Effect.all({
        withAlbums: db.select(LIBRARY_ARTIST_COLUMNS).from(artists).where(inArray(artists.id, owners)),
        featured: db.select(LIBRARY_ARTIST_COLUMNS).from(artists).where(notInArray(artists.id, owners)),
      });
    }).pipe(
      Effect.map(({ withAlbums, featured }): ArtistIndex => {
        const byNames = (left: { name: string }, right: { name: string }) => byName.compare(left.name, right.name);
        return { withAlbums: withAlbums.sort(byNames), featured: featured.sort(byNames) };
      }),
    ),

  /** An album and its songs in `ALBUM_ORDER`, the order it plays in, from one transaction. */
  album: (albumId: string) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.all({
          album: tx
            .select(LIBRARY_ALBUM_COLUMNS)
            .from(albums)
            .where(eq(albums.id, albumId))
            .pipe(Effect.map(([album]) => album ?? null)),
          songs: tx
            .select(LIBRARY_SONG_COLUMNS)
            .from(songs)
            .where(eq(songs.albumId, albumId))
            .orderBy(...albumSongOrder()),
        }),
      ),
    ).pipe(Effect.map((detail): AlbumDetail => detail)),

  /** An artist's row and its own albums in `ARTIST_ALBUM_ORDER`, from one transaction. */
  artist: (artistId: string) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.all({
          artist: tx
            .select(LIBRARY_ARTIST_COLUMNS)
            .from(artists)
            .where(eq(artists.id, artistId))
            .pipe(Effect.map(([artist]) => artist ?? null)),
          albums: tx
            .select(LIBRARY_ALBUM_COLUMNS)
            .from(albums)
            .where(ownAlbum(artistId))
            .orderBy(...artistAlbumOrder()),
        }),
      ),
    ).pipe(Effect.map((detail): ArtistDetail => detail)),

  /**
   * An artist's albums and their songs album after album, then the songs that credit it on others'
   * albums, in the order the artist plays in (`openArtist`), from one transaction.
   */
  discography: (artistId: string) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const songsWhere = (where: SQL | undefined) =>
            tx
              .select(LIBRARY_SONG_COLUMNS)
              .from(songs)
              .innerJoin(albums, eq(albums.id, songs.albumId))
              .where(where)
              .orderBy(...artistAlbumOrder(), ...albumSongOrder());
          const discography: Discography = {
            albums: yield* tx
              .select(LIBRARY_ALBUM_COLUMNS)
              .from(albums)
              .where(ownAlbum(artistId))
              .orderBy(...artistAlbumOrder()),
            songs: yield* songsWhere(ownAlbum(artistId)),
            appearsOn: yield* songsWhere(creditedOnOthers(artistId)),
          };
          return discography;
        }),
      ),
    ),

  /** The albums of `ids` that the library has, in `ARTIST_ALBUM_ORDER`. */
  albumsByIds: (ids: ReadonlyArray<string>) =>
    Db.use((db) =>
      db
        .select(LIBRARY_ALBUM_COLUMNS)
        .from(albums)
        .where(inIds(albums.id, [...new Set(ids)]))
        .orderBy(...artistAlbumOrder()),
    ),

  /** The songs of `ids` that the library has, as renderers get them, in no particular order. */
  librarySongsByIds: (ids: ReadonlyArray<string>) => Db.use((db) => librarySongsIn(db, ids)),

  /** A playlist as stored and the songs of its entries that the library has, from one transaction. */
  playlist: (playlistId: string) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          const [playlist = null] = yield* tx.select().from(playlists).where(eq(playlists.id, playlistId));
          const detail: PlaylistDetail = { playlist, songs: yield* librarySongsIn(tx, playlist?.local?.entries.map(({ songId }) => songId) ?? []) };
          return detail;
        }),
      ),
    ),

  /** Every playlist, the ones awaiting deletion on the server among them. */
  playlists: () => Db.use((db) => db.select().from(playlists)).pipe(Effect.map((rows): PlaylistRow[] => rows)),

  /** What the album, artist or playlist `ref` is called; `null` for the library, or for one the library does not have. */
  sourceName: (ref: QueueSourceRef) =>
    Db.use((db): Effect.Effect<string | null, unknown> => {
      switch (ref.type) {
        case "album":
          return db
            .select({ name: albums.name })
            .from(albums)
            .where(eq(albums.id, ref.albumId))
            .pipe(Effect.map(([row]) => row?.name ?? null));
        case "artist":
          return db
            .select({ name: artists.name })
            .from(artists)
            .where(eq(artists.id, ref.artistId))
            .pipe(Effect.map(([row]) => row?.name ?? null));
        case "playlist":
          return db
            .select({ local: playlists.local })
            .from(playlists)
            .where(eq(playlists.id, ref.playlistId))
            .pipe(Effect.map(([row]) => row?.local?.name ?? null));
        case "library":
          return Effect.succeed(null);
      }
    }),

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

  /**
   * The rows of what a search found, in the order it found them, leaving out any that have gone since.
   * Songs come as renderers get them, and playlists with what their result shows.
   */
  searchResults: (hits: ReadonlyArray<SearchHit>) =>
    Db.use((db) => {
      const idsOf = (type: SearchHit["type"]) => hits.flatMap((hit) => (hit.type === type ? [hit.id] : []));
      const [songIds, albumIds, artistIds, playlistIds] = [idsOf("song"), idsOf("album"), idsOf("artist"), idsOf("playlist")];
      return Effect.all([
        songIds.length ? db.select(LIBRARY_SONG_COLUMNS).from(songs).where(inArray(songs.id, songIds)) : Effect.succeed([]),
        albumIds.length ? db.select().from(albums).where(inArray(albums.id, albumIds)) : Effect.succeed([]),
        artistIds.length ? db.select().from(artists).where(inArray(artists.id, artistIds)) : Effect.succeed([]),
        playlistIds.length ? playlistResults(db, playlistIds) : Effect.succeed([]),
      ]);
    }).pipe(
      Effect.map(([songRows, albumRows, artistRows, playlistRows]) => {
        const found = new Map<string, SearchResult>([
          ...songRows.map((song) => [`song:${song.id}`, { type: "song", id: song.id, song }] as const),
          ...albumRows.map((album) => [`album:${album.id}`, { type: "album", id: album.id, album }] as const),
          ...artistRows.map((artist) => [`artist:${artist.id}`, { type: "artist", id: artist.id, artist }] as const),
          ...playlistRows.map((playlist) => [`playlist:${playlist.id}`, { type: "playlist", id: playlist.id, playlist }] as const),
        ]);
        return hits.flatMap((hit) => found.get(`${hit.type}:${hit.id}`) ?? []);
      }),
    ),

  /**
   * Where `artistId` appears on other artists' albums: the albums with a song that credits it. The
   * credits are JSON on each song, so this reads every song, which SQLite does far faster than a page.
   * Only the songs whose credits hold the id as JSON writes it, quoted, are taken apart: the few
   * that might credit it. JSON.stringify wrote the column, and writes the id the same way here.
   */
  artistAppearances: (artistId: string) =>
    Db.use((db) =>
      db.all<{ albumId: string; name: string | null }>(sql`
        SELECT DISTINCT ${songs.albumId} AS albumId, json_extract(credit.value, '$.name') AS name
        FROM ${songs}
        JOIN ${albums} ON ${albums.id} = ${songs.albumId}
        JOIN json_each(${songs.artists}) AS credit
        WHERE instr(${songs.artists}, ${JSON.stringify(artistId)}) > 0
          AND json_extract(credit.value, '$.id') = ${artistId} AND NOT ${ownAlbum(artistId)}
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

  /** Applies a change to the stored queue in one transaction; `null` leaves the state row or the resume position as it is. The queue's tables are not announced. */
  writeQueue: (change: { readonly upsert: ReadonlyArray<QueueItemRow>; readonly remove: ReadonlyArray<string>; readonly state: QueueStateRow | null; readonly resumePositionSeconds: number | null }) =>
    Db.use((db) =>
      db.transaction((tx) =>
        Effect.gen(function* () {
          for (const chunk of chunks(change.remove, STATEMENT_IDS)) yield* tx.delete(queueItems).where(inArray(queueItems.key, [...chunk]));
          for (const row of change.upsert) {
            yield* tx
              .insert(queueItems)
              .values(row)
              .onConflictDoUpdate({ target: queueItems.key, set: { list: row.list, position: row.position, track: row.track } });
          }
          if (change.state) yield* tx.insert(queueState).values(change.state).onConflictDoUpdate({ target: queueState.id, set: change.state });
          const positionSeconds = change.resumePositionSeconds;
          if (positionSeconds !== null) yield* tx.insert(queueResume).values({ id: 1, positionSeconds }).onConflictDoUpdate({ target: queueResume.id, set: { positionSeconds } });
        }),
      ),
    ),

  clearQueue: Db.use((db) => db.transaction((tx) => Effect.all([tx.delete(queueItems), tx.delete(queueState), tx.delete(queueResume)], { discard: true }))),
};
