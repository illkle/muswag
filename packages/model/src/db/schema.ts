import { desc } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { ArtistID3, Contributor, DiscTitle, ItemDate, ItemGenre, MediaType, RecordLabel, ReplayGain } from "../api/subsonic-api-schema.js";
import type { PlaylistState } from "../playlists/types.js";
import type { NowPlaying, QueueSourceRef, SourceCursor } from "../player-queue.js";

/**
 * The library database. Main owns it; the renderer mirrors `MIRRORED_TABLES` as TanStack DB
 * collections. Columns follow the Subsonic field names, so an API object maps onto a row by key.
 */

const json = <T>() => text({ mode: "json" }).$type<T>();

export const artists = sqliteTable("artists", {
  id: text().primaryKey(),
  name: text().notNull(),
  albumCount: integer(),
  starred: text(),
  coverArt: text(),
  artistImageUrl: text(),
  musicBrainzId: text(),
  sortName: text(),
  /** The file holding the image `coverArt` names, relative to the app data directory. Null until it is downloaded. */
  coverArtPath: text(),
});

export const albums = sqliteTable(
  "albums",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    artist: text(),
    artistId: text(),
    coverArt: text(),
    created: text().notNull(),
    duration: real().notNull(),
    genre: text(),
    playCount: real(),
    songCount: integer().notNull(),
    starred: text(),
    year: integer(),
    version: text(),
    played: text(),
    userRating: real(),
    recordLabels: json<ReadonlyArray<RecordLabel>>(),
    musicBrainzId: text(),
    genres: json<ReadonlyArray<ItemGenre>>(),
    artists: json<ReadonlyArray<ArtistID3>>(),
    displayArtist: text(),
    releaseTypes: json<ReadonlyArray<string>>(),
    moods: json<ReadonlyArray<string>>(),
    sortName: text(),
    originalReleaseDate: json<ItemDate>(),
    releaseDate: json<ItemDate>(),
    isCompilation: integer({ mode: "boolean" }),
    explicitStatus: text(),
    discTitles: json<ReadonlyArray<DiscTitle>>(),
    /** The file holding the image `coverArt` names, relative to the app data directory. Null until it is downloaded. */
    coverArtPath: text(),
  },
  (table) => [
    // The order of the albums page, which renderers read by the page: newest first, and SQLite puts a missing year last going down.
    index("albums_year").on(desc(table.year), table.id),
    // An artist's page, its discography and the artists that have albums.
    index("albums_artist_id").on(table.artistId),
  ],
);

export const songs = sqliteTable(
  "songs",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    /** What the library's order by title sorts by, made from the title by `sortKey`. */
    titleSortKey: text().notNull().default(""),
    /** What the order by artist sorts by: `artistOrderKey`. */
    artistOrderKey: text().notNull().default(""),
    /** What the order by album sorts by: `albumOrderKey`. */
    albumOrderKey: text().notNull().default(""),
    isDir: integer({ mode: "boolean" }).notNull(),
    album: text(),
    albumId: text(),
    artist: text(),
    artistId: text(),
    averageRating: real(),
    bitRate: real(),
    bookmarkPosition: real(),
    contentType: text(),
    coverArt: text(),
    created: text(),
    discNumber: integer(),
    duration: real(),
    genre: text(),
    isVideo: integer({ mode: "boolean" }),
    originalHeight: integer(),
    originalWidth: integer(),
    parent: text(),
    path: text(),
    playCount: real(),
    size: real(),
    starred: text(),
    suffix: text(),
    track: integer(),
    transcodedContentType: text(),
    transcodedSuffix: text(),
    type: text().$type<MediaType>(),
    userRating: real(),
    year: integer(),
    played: text(),
    bpm: real(),
    comment: text(),
    sortName: text(),
    musicBrainzId: text(),
    genres: json<ReadonlyArray<ItemGenre>>(),
    artists: json<ReadonlyArray<ArtistID3>>(),
    displayArtist: text(),
    albumArtists: json<ReadonlyArray<ArtistID3>>(),
    displayAlbumArtist: text(),
    contributors: json<ReadonlyArray<Contributor>>(),
    displayComposer: text(),
    moods: json<ReadonlyArray<string>>(),
    replayGain: json<ReplayGain>(),
    explicitStatus: text(),
  },
  (table) => [
    index("songs_album_id").on(table.albumId),
    index("songs_title_sort").on(table.titleSortKey, table.id),
    index("songs_artist_sort").on(table.artistOrderKey, table.id),
    index("songs_album_sort").on(table.albumOrderKey, table.id),
  ],
);

/**
 * A playlist as the user sees it (`local`) and as it was last synced with the server (`base`).
 * `local: null` is a tombstone for a playlist awaiting deletion on the server.
 */
export const playlists = sqliteTable("playlists", {
  id: text().primaryKey(),
  serverId: text(),
  base: json<PlaylistState>(),
  local: json<PlaylistState>(),
  revision: integer().notNull(),
});

// ---- The playback queue ----

/**
 * Every occurrence the queue holds: the user queue, the window of the source being played, and the
 * occurrence playing when it is in neither. Each carries its own copy of the track, so the queue
 * survives the song leaving the library.
 */
export const queueItems = sqliteTable("queue_items", {
  key: text().primaryKey(),
  list: text({ enum: ["now", "user", "source"] }).notNull(),
  /** Order within the list: the index in the user queue, or the occurrence's offset in its source. */
  position: integer().notNull(),
  track: json<Song>().notNull(),
});

/** The queue's single row (`id` 1): what is playing and the source it plays from. */
export const queueState = sqliteTable("queue_state", {
  id: integer().primaryKey(),
  nowPlayingKey: text(),
  nowPlayingOrigin: text({ enum: ["source", "user"] }).$type<NowPlaying["origin"]>(),
  source: json<{ ref: QueueSourceRef; cursor: SourceCursor; hasMore: boolean }>(),
});

// ---- Main-only tables ----

/**
 * Where playback resumes after a restart, in a single row (`id` 1). It is written every few seconds
 * while a track plays, so it is kept out of the tables renderers mirror. Restores always start paused,
 * so play state is not kept.
 */
export const queueResume = sqliteTable("queue_resume", {
  id: integer().primaryKey(),
  positionSeconds: real().notNull(),
});

/** How the library sync left things, in a single row (`id` 1). */
export const syncState = sqliteTable("sync_state", {
  id: integer().primaryKey(),
  /**
   * What the server said of its last scan when a sync last brought every song up to date. While the
   * server says the same, no song has changed since, and a quick sync need not read them all.
   */
  serverScan: text(),
  lastSyncedAt: text(),
});

export const credentials = sqliteTable("credentials", {
  id: integer().primaryKey(),
  url: text().notNull(),
  username: text().notNull(),
  /** Subsonic's stand-in for the password: a salt and the MD5 of the password followed by it. Both empty once the server has refused them. */
  salt: text().notNull(),
  token: text().notNull(),
});

/** Tables the renderer mirrors. Everything else stays in main. */
export const MIRRORED_TABLES = [albums, artists, songs, playlists, queueItems, queueState] as const;

export type Album = typeof albums.$inferSelect;
export type Artist = typeof artists.$inferSelect;
export type Song = typeof songs.$inferSelect;
export type PlaylistRow = typeof playlists.$inferSelect;
export type QueueItemRow = typeof queueItems.$inferSelect;
export type QueueStateRow = typeof queueState.$inferSelect;
