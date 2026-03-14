import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import SubsonicAPI from "subsonic-api";

import type { AnyDrizzleDb } from "./drizzle/schema.js";
import { syncStateTable, userCredentialsTable } from "./drizzle/schema.js";
import { syncAlbums, type SyncAlbumsResult } from "./sync-albums.js";

const USER_CREDENTIALS_ROW_ID = 1;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";
export const DRIZZLE_MIGRATIONS_PATH = fileURLToPath(new URL("../drizzle", import.meta.url));

const userStateFromDB = async (db: AnyDrizzleDb) => {
  return (
    (await db.query.userCredentials.findFirst({
      where: eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID),
      columns: {
        url: true,
        username: true,
        password: true,
      },
    })) ?? null
  );
};

const storeUserState = async (db: AnyDrizzleDb, credentials: UserState) => {
  await db
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

  return credentials;
};

const syncStateFromDb = async (db: AnyDrizzleDb) => {
  return await db.query.syncState.findFirst({
    where: eq(syncStateTable.key, ALBUMS_LAST_SYNCED_AT_KEY),
  });
};

const verifyConnection = async (api: SubsonicAPI) => {
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
};

export type UserState = {
  url: string;
  username: string;
  password: string;
};

export type MaybeUserState = UserState | null;

type SyncManagerListener = (event: MaybeUserState) => void;

export class SyncManager {
  api: SubsonicAPI | undefined;
  readonly db: AnyDrizzleDb;
  readonly coverArtDir: string;
  private listeners: Set<SyncManagerListener>;

  constructor(
    db: AnyDrizzleDb,
    options: {
      coverArtDir?: string;
    } = {},
  ) {
    this.db = db;
    this.coverArtDir = options.coverArtDir ?? join(process.cwd(), ".muswag", "album-covers");
    this.listeners = new Set();
  }

  subscribe(listener: SyncManagerListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: MaybeUserState): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        console.error("SyncManager subscriber failed", cause);
      }
    }
  }

  async login(credentials: UserState): Promise<UserState> {
    const api = new SubsonicAPI({
      url: credentials.url,
      auth: {
        username: credentials.username,
        password: credentials.password,
      },
    });

    await verifyConnection(api);

    this.api = api;

    return storeUserState(this.db, credentials);
  }

  async logout(): Promise<MaybeUserState> {
    await this.db.delete(userCredentialsTable);
    return null;
  }

  async getUserState(): Promise<MaybeUserState> {
    return userStateFromDB(this.db);
  }

  async sync(): Promise<SyncAlbumsResult> {
    if (!this.api) {
      throw new Error("SyncManager.login() must be called before sync()");
    }

    const result = await syncAlbums(this.db, this.api, {
      coverArtDir: this.coverArtDir,
    });

    return result;
  }
}
