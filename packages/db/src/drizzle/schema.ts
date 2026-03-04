import { relations } from "drizzle-orm";
import { AsyncRemoteCallback, drizzle, RemoteCallback } from "drizzle-orm/sqlite-proxy";
import { customType, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
    name: text("name").notNull(),
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

export const syncStateTable = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const syncAlbumIdsTable = sqliteTable("sync_album_ids", {
  id: text("id").primaryKey(),
});

export const albumsRelations = relations(albumsTable, ({ many }) => ({
  recordLabels: many(albumRecordLabelsTable),
  genres: many(albumGenresTable),
  artists: many(albumArtistsTable),
  artistRoles: many(albumArtistRolesTable),
  releaseTypes: many(albumReleaseTypesTable),
  moods: many(albumMoodsTable),
  discTitles: many(albumDiscTitlesTable),
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

const schema = {
  albums: albumsTable,
  albumRecordLabels: albumRecordLabelsTable,
  albumGenres: albumGenresTable,
  albumArtists: albumArtistsTable,
  albumArtistRoles: albumArtistRolesTable,
  albumReleaseTypes: albumReleaseTypesTable,
  albumMoods: albumMoodsTable,
  albumDiscTitles: albumDiscTitlesTable,
  syncState: syncStateTable,
  syncAlbumIds: syncAlbumIdsTable,
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
  syncStateTable: createSelectSchema(syncStateTable),
  syncAlbumIdsTable: createSelectSchema(syncAlbumIdsTable),
};
