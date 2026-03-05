import { sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import SubsonicAPI from "subsonic-api";

import type { DrizzleDb } from "./drizzle/schema.js";
import { syncAlbums, type SyncAlbumsResult } from "./sync-albums.js";

type UsernamePasswordAuth = {
  username: string;
  password: string;
};

const INITIAL_SCHEMA_URL = new URL("../drizzle/0000_initial_schema.sql", import.meta.url);
const INITIAL_SCHEMA_BREAKPOINT = "\n--> statement-breakpoint\n";
const NODE_FS_PROMISES = "node:fs/promises";

let initialSchemaStatementsPromise: Promise<string[]> | undefined;

async function loadInitialSchemaSql(): Promise<string> {
  if (INITIAL_SCHEMA_URL.protocol === "file:") {
    const { readFile } = await import(NODE_FS_PROMISES);
    return readFile(INITIAL_SCHEMA_URL, "utf8");
  }

  const response = await fetch(INITIAL_SCHEMA_URL);
  if (!response.ok) {
    throw new Error(`Failed to load schema migration: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function getInitialSchemaStatements(): Promise<string[]> {
  initialSchemaStatementsPromise ??= loadInitialSchemaSql().then((schemaSql) =>
    schemaSql
      .split(INITIAL_SCHEMA_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
  );

  return initialSchemaStatementsPromise;
}

export type SyncConnection = {
  url: string;
} & UsernamePasswordAuth;

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
        const statements = await getInitialSchemaStatements();
        for (const statement of statements) {
          await this.db.run(statement);
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
        auth: { username: connection.username, password: connection.password },
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
