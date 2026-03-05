import path from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/sqlite-proxy/migrator";
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

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

export class SyncManager {
  readonly db: DrizzleDb;
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
        await this.db.run(sql.raw("PRAGMA foreign_keys = ON"));
        await migrate(
          this.db,
          async (migrationQueries) => {
            for (const query of migrationQueries) {
              if (query.trim().length === 0) {
                continue;
              }
              await this.db.run(sql.raw(query));
            }
          },
          { migrationsFolder },
        );
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
