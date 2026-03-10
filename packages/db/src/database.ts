import { eq, sql } from "drizzle-orm";
import { Data } from "effect";
import SubsonicAPI from "subsonic-api";

import type { DrizzleDb } from "./drizzle/schema.js";
import { syncStateTable, userCredentialsTable } from "./drizzle/schema.js";
import { syncAlbums, type SyncAlbumsResult } from "./sync-albums.js";

const INITIAL_SCHEMA_URL = new URL("../drizzle/0000_initial_schema.sql", import.meta.url);
const INITIAL_SCHEMA_BREAKPOINT = "\n--> statement-breakpoint\n";
const NODE_FS_PROMISES = "node:fs/promises";
const USER_CREDENTIALS_ROW_ID = 1;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";

let initialSchemaStatementsPromise: Promise<string[]> | undefined;

export type SyncCredentials = {
  url: string;
  username: string;
  password: string;
};

export type SyncUserState =
  | {
      status: "logged_out";
    }
  | {
      status: "logged_in";
      url: string;
      username: string;
      lastSyncedAt: string | null;
    };

export type SyncManagerEvent =
  | {
      type: "db state synced";
      result: SyncAlbumsResult;
    }
  | {
      type: "user update";
      userState: SyncUserState;
    };

type SyncManagerListener = (event: SyncManagerEvent) => void;
type StoredCredentialsRow = typeof userCredentialsTable.$inferSelect;

export class SyncManagerConnectionError extends Data.TaggedError("SyncManagerConnectionError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncManagerSchemaError extends Data.TaggedError("SyncManagerSchemaError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncManagerNotLoggedInError extends Data.TaggedError("SyncManagerNotLoggedInError")<{
  message: string;
}> {}

export class SyncManagerSyncError extends Data.TaggedError("SyncManagerSyncError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncManagerUserStateError extends Data.TaggedError("SyncManagerUserStateError")<{
  message: string;
  cause: unknown;
}> {}

async function loadInitialSchemaSql(): Promise<string> {
  if (INITIAL_SCHEMA_URL.protocol === "file:") {
    const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
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

function toPublicUserState(credentials: StoredCredentialsRow | SyncCredentials | null): SyncUserState {
  if (!credentials) {
    return { status: "logged_out" };
  }

  return {
    status: "logged_in",
    url: credentials.url,
    username: credentials.username,
    lastSyncedAt: null,
  };
}

export class SyncManager {
  readonly db: DrizzleDb;
  private schemaReady: boolean;
  private listeners: Set<SyncManagerListener>;

  constructor(db: DrizzleDb) {
    this.db = db;
    this.schemaReady = false;
    this.listeners = new Set();
  }

  subscribe(listener: SyncManagerListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SyncManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (cause) {
        console.error("SyncManager subscriber failed", cause);
      }
    }
  }

  private async initializeSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }

    try {
      await this.db.run(sql.raw("PRAGMA foreign_keys = ON"));
      const statements = await getInitialSchemaStatements();
      for (const statement of statements) {
        await this.db.run(statement);
      }
      this.schemaReady = true;
    } catch (cause) {
      throw new SyncManagerSchemaError({
        message: "Initializing SQLite schema failed",
        cause,
      });
    }
  }

  private createApi(credentials: SyncCredentials): SubsonicAPI {
    return new SubsonicAPI({
      url: credentials.url,
      auth: {
        username: credentials.username,
        password: credentials.password,
      },
    });
  }

  private async verifyConnection(api: SubsonicAPI): Promise<void> {
    let lastCause: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await api.ping();
        return;
      } catch (cause) {
        lastCause = cause;
      }
    }

    throw new SyncManagerConnectionError({
      message: "Subsonic connectivity check failed",
      cause: lastCause,
    });
  }

  private async loadStoredCredentials(): Promise<StoredCredentialsRow | null> {
    try {
      const rows = await this.db
        .select()
        .from(userCredentialsTable)
        .where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID))
        .limit(1);

      return rows[0] ?? null;
    } catch (cause) {
      throw new SyncManagerUserStateError({
        message: "Loading stored user credentials failed",
        cause,
      });
    }
  }

  private async loadLastSyncedAt(): Promise<string | null> {
    try {
      const rows = await this.db
        .select({ value: syncStateTable.value })
        .from(syncStateTable)
        .where(eq(syncStateTable.key, ALBUMS_LAST_SYNCED_AT_KEY))
        .limit(1);

      return rows[0]?.value ?? null;
    } catch (cause) {
      throw new SyncManagerUserStateError({
        message: "Loading last sync timestamp failed",
        cause,
      });
    }
  }

  async login(credentials: SyncCredentials): Promise<SyncUserState> {
    await this.initializeSchema();

    const api = this.createApi(credentials);
    await this.verifyConnection(api);

    try {
      await this.db
        .insert(userCredentialsTable)
        .values({
          id: USER_CREDENTIALS_ROW_ID,
          url: credentials.url,
          username: credentials.username,
          password: credentials.password,
        })
        .onConflictDoUpdate({
          target: userCredentialsTable.id,
          set: {
            url: credentials.url,
            username: credentials.username,
            password: credentials.password,
          },
        });
    } catch (cause) {
      throw new SyncManagerUserStateError({
        message: "Persisting user credentials failed",
        cause,
      });
    }

    const userState = toPublicUserState(credentials);
    this.emit({
      type: "user update",
      userState,
    });

    return userState;
  }

  async logout(): Promise<SyncUserState> {
    await this.initializeSchema();

    const existing = await this.loadStoredCredentials();

    try {
      await this.db.delete(userCredentialsTable);
    } catch (cause) {
      throw new SyncManagerUserStateError({
        message: "Clearing stored user credentials failed",
        cause,
      });
    }

    const userState = toPublicUserState(null);
    if (existing) {
      this.emit({
        type: "user update",
        userState,
      });
    }

    return userState;
  }

  async getUserState(): Promise<SyncUserState> {
    await this.initializeSchema();

    const storedCredentials = await this.loadStoredCredentials();
    if (!storedCredentials) {
      return toPublicUserState(null);
    }

    return {
      status: "logged_in",
      url: storedCredentials.url,
      username: storedCredentials.username,
      lastSyncedAt: await this.loadLastSyncedAt(),
    };
  }

  async sync(): Promise<SyncAlbumsResult> {
    await this.initializeSchema();

    const storedCredentials = await this.loadStoredCredentials();
    if (!storedCredentials) {
      throw new SyncManagerNotLoggedInError({
        message: "SyncManager.login() must be called before sync()",
      });
    }

    const api = this.createApi(storedCredentials);
    let result: SyncAlbumsResult;

    try {
      result = await syncAlbums(this.db, api);
    } catch (cause) {
      throw new SyncManagerSyncError({
        message: "Album sync failed",
        cause,
      });
    }

    this.emit({
      type: "db state synced",
      result,
    });
    this.emit({
      type: "user update",
      userState: await this.getUserState(),
    });

    return result;
  }
}
