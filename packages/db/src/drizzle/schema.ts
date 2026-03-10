import { relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { AsyncRemoteCallback, RemoteCallback } from "drizzle-orm/sqlite-proxy";
import {
  customType,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-zod";

export type ItemDate = {
  year?: number | undefined;
  month?: number | undefined;
  day?: number | undefined;
};

const jsonItemDate = customType<{
  data: ItemDate | null;
  driverData: string | null;
}>({
  dataType() {
    return "text";
  },
  toDriver(value) {
    if (value === null) {
      return null;
    }
    return JSON.stringify(value);
  },
  fromDriver(value) {
    if (value === null || value === undefined || value === "" || value === "undefined") {
      return null;
    }
    return JSON.parse(value) as ItemDate;
  },
});

export const albumsTable = sqliteTable("albums", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version"),
  artist: text("artist"),
  artistId: text("artist_id"),
  coverArt: text("cover_art"),
  songCount: integer("song_count").notNull(),
  duration: integer("duration").notNull(),
  playCount: integer("play_count"),
  created: text("created").notNull(),
  starred: text("starred"),
  year: integer("year"),
  genre: text("genre"),
  played: text("played"),
  userRating: integer("user_rating"),
  musicBrainzId: text("music_brainz_id"),
  displayArtist: text("display_artist"),
  sortName: text("sort_name"),
  originalReleaseDate: jsonItemDate("original_release_date"),
  releaseDate: jsonItemDate("release_date"),
  isCompilation: integer("is_compilation", { mode: "boolean" }),
  explicitStatus: text("explicit_status"),
});

export const albumRecordLabelsTable = sqliteTable(
  "album_record_labels",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const albumGenresTable = sqliteTable(
  "album_genres",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const albumArtistsTable = sqliteTable(
  "album_artists",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    coverArt: text("cover_art"),
    artistImageUrl: text("artist_image_url"),
    albumCount: integer("album_count"),
    starred: text("starred"),
    musicBrainzId: text("music_brainz_id"),
    sortName: text("sort_name"),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const albumArtistRolesTable = sqliteTable(
  "album_artist_roles",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    artistPosition: integer("artist_position").notNull(),
    position: integer("position").notNull(),
    role: text("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.artistPosition, table.position] })],
);

export const albumReleaseTypesTable = sqliteTable(
  "album_release_types",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const albumMoodsTable = sqliteTable(
  "album_moods",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const albumDiscTitlesTable = sqliteTable(
  "album_disc_titles",
  {
    albumId: text("album_id")
      .notNull()
      .references(() => albumsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    disc: integer("disc").notNull(),
    title: text("title").notNull(),
  },
  (table) => [primaryKey({ columns: [table.albumId, table.position] })],
);

export const songsTable = sqliteTable("songs", {
  id: text("id").primaryKey(),
  album: text("album").notNull(),
  albumId: text("album_id")
    .notNull()
    .references(() => albumsTable.id, { onDelete: "cascade" }),
  artist: text("artist"),
  artistId: text("artist_id"),
  averageRating: integer("average_rating"),
  bitRate: integer("bit_rate"),
  bookmarkPosition: integer("bookmark_position"),
  contentType: text("content_type"),
  coverArt: text("cover_art"),
  created: text("created"),
  discNumber: integer("disc_number"),
  duration: integer("duration"),
  genre: text("genre"),
  isDir: integer("is_dir", { mode: "boolean" }).notNull(),
  isVideo: integer("is_video", { mode: "boolean" }),
  originalHeight: integer("original_height"),
  originalWidth: integer("original_width"),
  parent: text("parent"),
  path: text("path"),
  playCount: integer("play_count"),
  size: integer("size"),
  starred: text("starred"),
  suffix: text("suffix"),
  title: text("title").notNull(),
  track: integer("track"),
  transcodedContentType: text("transcoded_content_type"),
  transcodedSuffix: text("transcoded_suffix"),
  type: text("type"),
  userRating: integer("user_rating"),
  year: integer("year"),
  played: text("played"),
  bpm: integer("bpm"),
  comment: text("comment"),
  sortName: text("sort_name"),
  musicBrainzId: text("music_brainz_id"),
  displayArtist: text("display_artist"),
  displayAlbumArtist: text("display_album_artist"),
  displayComposer: text("display_composer"),
  explicitStatus: text("explicit_status"),
});

export const songGenresTable = sqliteTable(
  "song_genres",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.songId, table.position] })],
);

export const songArtistsTable = sqliteTable(
  "song_artists",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    coverArt: text("cover_art"),
    artistImageUrl: text("artist_image_url"),
    albumCount: integer("album_count"),
    starred: text("starred"),
    musicBrainzId: text("music_brainz_id"),
    sortName: text("sort_name"),
  },
  (table) => [primaryKey({ columns: [table.songId, table.position] })],
);

export const songArtistRolesTable = sqliteTable(
  "song_artist_roles",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    artistPosition: integer("artist_position").notNull(),
    position: integer("position").notNull(),
    role: text("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.songId, table.artistPosition, table.position] })],
);

export const songAlbumArtistsTable = sqliteTable(
  "song_album_artists",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    id: text("id").notNull(),
    name: text("name").notNull(),
    coverArt: text("cover_art"),
    artistImageUrl: text("artist_image_url"),
    albumCount: integer("album_count"),
    starred: text("starred"),
    musicBrainzId: text("music_brainz_id"),
    sortName: text("sort_name"),
  },
  (table) => [primaryKey({ columns: [table.songId, table.position] })],
);

export const songAlbumArtistRolesTable = sqliteTable(
  "song_album_artist_roles",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    artistPosition: integer("artist_position").notNull(),
    position: integer("position").notNull(),
    role: text("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.songId, table.artistPosition, table.position] })],
);

export const songContributorsTable = sqliteTable(
  "song_contributors",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").notNull(),
    subRole: text("sub_role"),
    artistId: text("artist_id"),
    artistName: text("artist_name"),
    coverArt: text("cover_art"),
    artistImageUrl: text("artist_image_url"),
    albumCount: integer("album_count"),
    starred: text("starred"),
    musicBrainzId: text("music_brainz_id"),
    sortName: text("sort_name"),
  },
  (table) => [primaryKey({ columns: [table.songId, table.position] })],
);

export const songMoodsTable = sqliteTable(
  "song_moods",
  {
    songId: text("song_id")
      .notNull()
      .references(() => songsTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    value: text("value").notNull(),
  },
  (table) => [primaryKey({ columns: [table.songId, table.position] })],
);

export const songReplayGainTable = sqliteTable("song_replay_gain", {
  songId: text("song_id")
    .primaryKey()
    .references(() => songsTable.id, { onDelete: "cascade" }),
  trackGain: real("track_gain"),
  albumGain: real("album_gain"),
  trackPeak: real("track_peak"),
  albumPeak: real("album_peak"),
  baseGain: real("base_gain"),
  fallbackGain: real("fallback_gain"),
});

export const syncStateTable = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const syncAlbumIdsTable = sqliteTable("sync_album_ids", {
  id: text("id").primaryKey(),
});

export const userCredentialsTable = sqliteTable("user_credentials", {
  id: integer("id").primaryKey(),
  url: text("url").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
});

export const albumsRelations = relations(albumsTable, ({ many }) => ({
  recordLabels: many(albumRecordLabelsTable),
  genres: many(albumGenresTable),
  artists: many(albumArtistsTable),
  artistRoles: many(albumArtistRolesTable),
  releaseTypes: many(albumReleaseTypesTable),
  moods: many(albumMoodsTable),
  discTitles: many(albumDiscTitlesTable),
  songs: many(songsTable),
}));

export const albumRecordLabelsRelations = relations(albumRecordLabelsTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumRecordLabelsTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const albumGenresRelations = relations(albumGenresTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumGenresTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const albumArtistsRelations = relations(albumArtistsTable, ({ many, one }) => ({
  album: one(albumsTable, {
    fields: [albumArtistsTable.albumId],
    references: [albumsTable.id],
  }),
  roles: many(albumArtistRolesTable),
}));

export const albumArtistRolesRelations = relations(albumArtistRolesTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumArtistRolesTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const albumReleaseTypesRelations = relations(albumReleaseTypesTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumReleaseTypesTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const albumMoodsRelations = relations(albumMoodsTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumMoodsTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const albumDiscTitlesRelations = relations(albumDiscTitlesTable, ({ one }) => ({
  album: one(albumsTable, {
    fields: [albumDiscTitlesTable.albumId],
    references: [albumsTable.id],
  }),
}));

export const songsRelations = relations(songsTable, ({ many, one }) => ({
  album: one(albumsTable, {
    fields: [songsTable.albumId],
    references: [albumsTable.id],
  }),
  genres: many(songGenresTable),
  artists: many(songArtistsTable),
  artistRoles: many(songArtistRolesTable),
  albumArtists: many(songAlbumArtistsTable),
  albumArtistRoles: many(songAlbumArtistRolesTable),
  contributors: many(songContributorsTable),
  moods: many(songMoodsTable),
  replayGain: many(songReplayGainTable),
}));

export const songGenresRelations = relations(songGenresTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songGenresTable.songId],
    references: [songsTable.id],
  }),
}));

export const songArtistsRelations = relations(songArtistsTable, ({ many, one }) => ({
  song: one(songsTable, {
    fields: [songArtistsTable.songId],
    references: [songsTable.id],
  }),
  roles: many(songArtistRolesTable),
}));

export const songArtistRolesRelations = relations(songArtistRolesTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songArtistRolesTable.songId],
    references: [songsTable.id],
  }),
}));

export const songAlbumArtistsRelations = relations(songAlbumArtistsTable, ({ many, one }) => ({
  song: one(songsTable, {
    fields: [songAlbumArtistsTable.songId],
    references: [songsTable.id],
  }),
  roles: many(songAlbumArtistRolesTable),
}));

export const songAlbumArtistRolesRelations = relations(songAlbumArtistRolesTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songAlbumArtistRolesTable.songId],
    references: [songsTable.id],
  }),
}));

export const songContributorsRelations = relations(songContributorsTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songContributorsTable.songId],
    references: [songsTable.id],
  }),
}));

export const songMoodsRelations = relations(songMoodsTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songMoodsTable.songId],
    references: [songsTable.id],
  }),
}));

export const songReplayGainRelations = relations(songReplayGainTable, ({ one }) => ({
  song: one(songsTable, {
    fields: [songReplayGainTable.songId],
    references: [songsTable.id],
  }),
}));

const schema = {
  albums: albumsTable,
  albumRecordLabels: albumRecordLabelsTable,
  albumGenres: albumGenresTable,
  albumArtists: albumArtistsTable,
  albumArtistRoles: albumArtistRolesTable,
  albumReleaseTypes: albumReleaseTypesTable,
  albumMoods: albumMoodsTable,
  albumDiscTitles: albumDiscTitlesTable,
  songs: songsTable,
  songGenres: songGenresTable,
  songArtists: songArtistsTable,
  songArtistRoles: songArtistRolesTable,
  songAlbumArtists: songAlbumArtistsTable,
  songAlbumArtistRoles: songAlbumArtistRolesTable,
  songContributors: songContributorsTable,
  songMoods: songMoodsTable,
  songReplayGain: songReplayGainTable,
  syncState: syncStateTable,
  syncAlbumIds: syncAlbumIdsTable,
  userCredentials: userCredentialsTable,
};

export const dbq = drizzle(async () => ({ rows: [] }), { schema });

export function createDrizzleDb(remoteCallback: RemoteCallback | AsyncRemoteCallback) {
  return drizzle(remoteCallback, { schema });
}

export type DrizzleDb = ReturnType<typeof createDrizzleDb>;

export const DBZodValidators = {
  albumsTable: createSelectSchema(albumsTable),
  albumRecordLabelsTable: createSelectSchema(albumRecordLabelsTable),
  albumGenresTable: createSelectSchema(albumGenresTable),
  albumArtistsTable: createSelectSchema(albumArtistsTable),
  albumArtistRolesTable: createSelectSchema(albumArtistRolesTable),
  albumReleaseTypesTable: createSelectSchema(albumReleaseTypesTable),
  albumMoodsTable: createSelectSchema(albumMoodsTable),
  albumDiscTitlesTable: createSelectSchema(albumDiscTitlesTable),
  songsTable: createSelectSchema(songsTable),
  songGenresTable: createSelectSchema(songGenresTable),
  songArtistsTable: createSelectSchema(songArtistsTable),
  songArtistRolesTable: createSelectSchema(songArtistRolesTable),
  songAlbumArtistsTable: createSelectSchema(songAlbumArtistsTable),
  songAlbumArtistRolesTable: createSelectSchema(songAlbumArtistRolesTable),
  songContributorsTable: createSelectSchema(songContributorsTable),
  songMoodsTable: createSelectSchema(songMoodsTable),
  songReplayGainTable: createSelectSchema(songReplayGainTable),
  syncStateTable: createSelectSchema(syncStateTable),
  syncAlbumIdsTable: createSelectSchema(syncAlbumIdsTable),
  userCredentialsTable: createSelectSchema(userCredentialsTable),
};
