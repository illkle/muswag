import type { DbAdapter } from "./public-api.js";

export async function migrate(db: DbAdapter): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        artist TEXT,
        artist_id TEXT,
        cover_art TEXT,
        song_count INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        play_count INTEGER,
        year INTEGER,
        genre TEXT,
        created TEXT NOT NULL,
        starred TEXT,
        played TEXT,
        user_rating INTEGER,
        sort_name TEXT,
        music_brainz_id TEXT,
        is_compilation INTEGER,
        raw_json TEXT NOT NULL,
        synced_at TEXT NOT NULL
      )
    `);

    await tx.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    await tx.exec(`
      CREATE TABLE IF NOT EXISTS sync_album_ids (
        id TEXT PRIMARY KEY
      )
    `);

    await tx.exec("CREATE INDEX IF NOT EXISTS idx_albums_artist_id ON albums(artist_id)");
  });
}
