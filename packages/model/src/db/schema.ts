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
  starred: text(),
  userRating: real(),
  averageRating: real(),
  coverArt: text(),
  artistImageUrl: text(),
  /** Cached cover file, relative to the app data directory. */
  coverArtPath: text(),
  coverArtSourceId: text(),
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
    /** Cached cover file, relative to the app data directory. */
    coverArtPath: text(),
    coverArtSourceId: text(),
  },
  (table) => [index("albums_artist_id").on(table.artistId)],
);

export const songs = sqliteTable(
  "songs",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    /** What the alphabetical order of the library sorts by, made from the title by `titleSortKey`. */
    titleSortKey: text().notNull().default(""),
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
  (table) => [index("songs_album_id").on(table.albumId), index("songs_title_sort").on(table.titleSortKey, table.id)],
);

/**
 * A playlist as the user sees it (`local`) and as it was last synced with the server (`base`).
 * `local: null` is a tombstone for a playlist awaiting deletion on the server.
 */
export const playlists = sqliteTable(
  "playlists",
  {
    id: text().primaryKey(),
    serverId: text(),
    base: json<PlaylistState>(),
    local: json<PlaylistState>(),
    revision: integer().notNull(),
  },
  (table) => [index("playlists_server_id").on(table.serverId)],
);

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

/** The queue's single row (`id` 1): what is playing, the source it plays from, and where to resume. */
export const queueState = sqliteTable("queue_state", {
  id: integer().primaryKey(),
  nowPlayingKey: text(),
  nowPlayingOrigin: text({ enum: ["source", "user"] }).$type<NowPlaying["origin"]>(),
  source: json<{ ref: QueueSourceRef; cursor: SourceCursor; revision: string; hasMore: boolean }>(),
  /** Where playback resumes after a restart. Restores always start paused, so play state is not kept. */
  resumePositionSeconds: real().notNull(),
});

// ---- Main-only tables ----

export const syncState = sqliteTable("sync_state", {
  id: integer().primaryKey(),
  indexesLastModified: integer(),
  lastFullSyncAt: text(),
  lastQuickSyncAt: text(),
});

/** Cover files on disk, keyed by the image they hold. */
export const covers = sqliteTable("covers", {
  key: text().primaryKey(),
  fileName: text().notNull(),
});

export const credentials = sqliteTable("credentials", {
  id: integer().primaryKey(),
  url: text().notNull(),
  username: text().notNull(),
  /** Encrypted with the OS keychain when `encrypted`, otherwise plain text. */
  password: text().notNull(),
  encrypted: integer({ mode: "boolean" }).notNull(),
});

/** Tables the renderer mirrors. Everything else stays in main. */
export const MIRRORED_TABLES = [albums, artists, songs, playlists, queueItems, queueState] as const;

export type Album = typeof albums.$inferSelect;
export type Artist = typeof artists.$inferSelect;
export type Song = typeof songs.$inferSelect;
export type PlaylistRow = typeof playlists.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type QueueItemRow = typeof queueItems.$inferSelect;
export type QueueStateRow = typeof queueState.$inferSelect;
export type CoverRow = typeof covers.$inferSelect;
