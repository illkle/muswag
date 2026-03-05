import { sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import SubsonicAPI from "subsonic-api";

import { DrizzleDb } from "./drizzle/schema.js";
import { syncAlbums, SyncAlbumsResult } from "./sync-albums.js";

type UsernamePasswordAuth = {
  username: string;
  password: string;
  apiKey?: never;
};

type ApiKeyAuth = {
  apiKey: string;
  username?: never;
  password?: never;
};

export type SyncConnection = {
  url: string;
} & (UsernamePasswordAuth | ApiKeyAuth);

export class SyncManagerConnectionError extends Data.TaggedError("SyncManagerConnectionError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncManagerSchemaError extends Data.TaggedError("SyncManagerSchemaError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncManagerNotConnectedError extends Data.TaggedError("SyncManagerNotConnectedError")<{
  message: string;
}> {}

export class SyncManagerSyncError extends Data.TaggedError("SyncManagerSyncError")<{
  message: string;
  cause: unknown;
}> {}

const SCHEMA_STATEMENTS = [
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    version TEXT,
    artist TEXT,
    artist_id TEXT,
    cover_art TEXT,
    song_count INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    play_count INTEGER,
    created INTEGER NOT NULL,
    starred INTEGER,
    year INTEGER,
    genre TEXT,
    played TEXT,
    user_rating INTEGER,
    music_brainz_id TEXT,
    display_artist TEXT,
    sort_name TEXT,
    original_release_date TEXT,
    release_date TEXT,
    is_compilation INTEGER,
    explicit_status TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS album_record_labels (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_genres (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_artists (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    cover_art TEXT,
    artist_image_url TEXT,
    album_count INTEGER,
    starred INTEGER,
    music_brainz_id TEXT,
    sort_name TEXT,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_artist_roles (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    artist_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    PRIMARY KEY (album_id, artist_position, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_release_types (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_moods (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS album_disc_titles (
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    disc INTEGER NOT NULL,
    title TEXT NOT NULL,
    PRIMARY KEY (album_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_album_ids (
    id TEXT PRIMARY KEY NOT NULL
  )`,
] as const;

export class SyncManager {
  private readonly db: DrizzleDb;
  private api: SubsonicAPI | null;
  private schemaReady: boolean;

  constructor(db: DrizzleDb) {
    this.db = db;
    this.api = null;
    this.schemaReady = false;
  }

  private initializeSchema() {
    if (this.schemaReady) {
      return Effect.void;
    }

    return Effect.tryPromise({
      try: async () => {
        for (const statement of SCHEMA_STATEMENTS) {
          await this.db.run(sql.raw(statement));
        }
        this.schemaReady = true;
      },
      catch: (cause) =>
        new SyncManagerSchemaError({
          message: "Initializing SQLite schema failed",
          cause,
        }),
    });
  }

  async connect(connection: SyncConnection): Promise<void> {
    const self = this;
    const program = Effect.gen(function* () {
      const api = new SubsonicAPI({
        url: connection.url,
        auth:
          "apiKey" in connection
            ? { apiKey: connection.apiKey }
            : { username: connection.username, password: connection.password },
      });

      yield* Effect.retry(
        Effect.tryPromise({
          try: () => api.ping(),
          catch: (cause) =>
            new SyncManagerConnectionError({
              message: "Subsonic connectivity check failed",
              cause,
            }),
        }),
        { times: 2 },
      );

      self.api = api;
    });

    return Effect.runPromise(program);
  }

  async sync(): Promise<SyncAlbumsResult> {
    const self = this;
    const program = Effect.gen(function* () {
      yield* self.initializeSchema();

      if (!self.api) {
        return yield* Effect.fail(new Error("SyncManager.connect() must be called before sync()"));
      }

      const api = self.api;

      return yield* Effect.tryPromise({
        try: () => syncAlbums(self.db, api),
        catch: (cause) => {
          return new Error(`Album sync failed ${cause}`);
        },
      });
    });

    return Effect.runPromise(program);
  }
}
