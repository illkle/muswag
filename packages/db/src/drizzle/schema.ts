import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const albumsTable = sqliteTable("albums", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  artist: text("artist"),
  artistId: text("artist_id"),
  coverArt: text("cover_art"),
  songCount: integer("song_count").notNull(),
  duration: integer("duration").notNull(),
  playCount: integer("play_count"),
  year: integer("year"),
  genre: text("genre"),
  created: text("created").notNull(),
  starred: text("starred"),
  played: text("played"),
  userRating: integer("user_rating"),
  sortName: text("sort_name"),
  musicBrainzId: text("music_brainz_id"),
  isCompilation: integer("is_compilation"),
  rawJson: text("raw_json").notNull(),
  syncedAt: text("synced_at").notNull()
});

export const syncStateTable = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const syncAlbumIdsTable = sqliteTable("sync_album_ids", {
  id: text("id").primaryKey()
});
