import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import SubsonicAPI from "subsonic-api";

import type { AnyDrizzleDb, BetterSqliteDrizzleDb } from "./drizzle/schema.js";
import { syncStateTable, userCredentialsTable } from "./drizzle/schema.js";
import { syncAlbums, type SyncAlbumsResult } from "./sync-albums.js";

const USER_CREDENTIALS_ROW_ID = 1;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";
const DRIZZLE_MIGRATIONS_PATH = fileURLToPath(new URL("../drizzle", import.meta.url));

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
  readonly db: AnyDrizzleDb;
  private listeners: Set<SyncManagerListener>;

  constructor(db: AnyDrizzleDb) {
    this.db = db;
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

    throw lastCause ?? new Error("Subsonic connectivity check failed");
  }

  private async loadStoredCredentials(): Promise<StoredCredentialsRow | null> {
    const rows = await this.db
      .select()
      .from(userCredentialsTable)
      .where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID))
      .limit(1);

    return rows[0] ?? null;
  }

  private async loadLastSyncedAt(): Promise<string | null> {
    const rows = await this.db
      .select({ value: syncStateTable.value })
      .from(syncStateTable)
      .where(eq(syncStateTable.key, ALBUMS_LAST_SYNCED_AT_KEY))
      .limit(1);

    return rows[0]?.value ?? null;
  }

  async login(credentials: SyncCredentials): Promise<SyncUserState> {
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

    const userState = toPublicUserState(credentials);
    this.emit({
      type: "user update",
      userState,
    });

    return userState;
  }

  async logout(): Promise<SyncUserState> {
    const existing = await this.loadStoredCredentials();
    await this.db.delete(userCredentialsTable);

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
    const storedCredentials = await this.loadStoredCredentials();
    if (!storedCredentials) {
      throw new Error("SyncManager.login() must be called before sync()");
    }

    const api = this.createApi(storedCredentials);
    const result = await syncAlbums(this.db, api);

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

export function migrateDb(db: BetterSqliteDrizzleDb): void {
  migrate(db, { migrationsFolder: DRIZZLE_MIGRATIONS_PATH });
}
