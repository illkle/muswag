import { eq, sql } from "drizzle-orm";
import SubsonicAPI from "subsonic-api";

import type { DrizzleDb } from "./drizzle/schema.js";
import { userCredentialsTable } from "./drizzle/schema.js";
import { syncAlbums, type SyncAlbumsResult } from "./sync-albums.js";

const INITIAL_SCHEMA_URL = new URL("../drizzle/0000_initial_schema.sql", import.meta.url);
const INITIAL_SCHEMA_BREAKPOINT = "\n--> statement-breakpoint\n";
const NODE_FS_PROMISES = "node:fs/promises";
const USER_CREDENTIALS_ROW_ID = 1;

let initialSchemaStatementsPromise: Promise<string[]> | undefined;

export type SyncCredentials = {
  url: string;
  username: string;
  password: string;
};

type EventFromSyncManager = "user_invalidate" | "data_invalidate";

type SyncManagerListener = (event: EventFromSyncManager) => void;
type StoredCredentialsRow = typeof userCredentialsTable.$inferSelect;

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

  private emit(event: EventFromSyncManager): void {
    console.log("emit event", event);
    for (const listener of this.listeners) {
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

    await this.db.run(sql.raw("PRAGMA foreign_keys = ON"));
    const statements = await getInitialSchemaStatements();
    for (const statement of statements) {
      await this.db.run(statement);
    }
    this.schemaReady = true;
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await api.ping();
        return;
      } catch (cause) {}
    }

    throw new Error("Subsonic connectivity check failed");
  }

  private async loadStoredCredentials(): Promise<StoredCredentialsRow | null> {
    const rows = await this.db
      .select()
      .from(userCredentialsTable)
      .where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID))
      .limit(1);

    return rows[0] ?? null;
  }

  async login(credentials: SyncCredentials) {
    await this.initializeSchema();

    const api = this.createApi(credentials);
    await this.verifyConnection(api);

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

    this.emit("user_invalidate");
  }

  async logout() {
    await this.initializeSchema();

    await this.db.delete(userCredentialsTable);

    this.emit("user_invalidate");
  }

  async getUserState() {
    await this.initializeSchema();

    return await this.loadStoredCredentials();
  }

  async sync(): Promise<SyncAlbumsResult> {
    await this.initializeSchema();

    const storedCredentials = await this.loadStoredCredentials();
    if (!storedCredentials) {
      throw new Error("SyncManager.login() must be called before sync()");
    }

    const api = this.createApi(storedCredentials);

    const result = await syncAlbums(this.db, api);

    this.emit("data_invalidate");

    return result;
  }
}
