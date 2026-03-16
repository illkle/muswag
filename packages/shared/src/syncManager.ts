import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import SubsonicAPI from "subsonic-api";

import type { AnyDrizzleDb } from "./drizzle/schema.js";
import { userCredentialsTable } from "./drizzle/schema.js";
import { syncAlbums } from "./sync/sync-albums.js";
import type { SyncEvent } from "./sync/utils.js";

const USER_CREDENTIALS_ROW_ID = 1;
const SUBSONIC_API_VERSION = "1.16.1";
export const DRIZZLE_MIGRATIONS_PATH = fileURLToPath(new URL("../drizzle", import.meta.url));

const userStateFromDB = async (db: AnyDrizzleDb) => {
  return (
    (await db.query.userCredentials.findFirst({
      where: eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID),
      columns: {
        url: true,
        username: true,
        password: true,
        lastSync: true,
      },
    })) ?? null
  );
};

const storeUserCredentials = async (db: AnyDrizzleDb, credentials: UserStateToLogin) => {
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

  return { ...credentials, lastSync: null };
};

const storeLastSync = async (db: AnyDrizzleDb, lastSync: string) => {
  await db
    .update(userCredentialsTable)
    .set({
      lastSync: lastSync,
    })
    .where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID));
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

export type MaybeUserState = Awaited<ReturnType<typeof userStateFromDB>>;

export type UserState = NonNullable<MaybeUserState>;
export type UserStateToLogin = Pick<UserState, "password" | "url" | "username">;

export function buildSubsonicStreamUrl(credentials: UserStateToLogin, songId: string): string {
  const salt = randomBytes(16).toString("hex");
  const token = createHash("md5").update(`${credentials.password}${salt}`).digest("hex");
  const url = new URL("stream.view", getSubsonicRestBaseUrl(credentials.url));

  url.searchParams.set("id", songId);
  url.searchParams.set("u", credentials.username);
  url.searchParams.set("t", token);
  url.searchParams.set("s", salt);
  url.searchParams.set("v", SUBSONIC_API_VERSION);
  url.searchParams.set("c", "muswag");

  return url.toString();
}

type SyncManagerListener = (event: SyncEvent) => void;

export class SyncManager {
  api: SubsonicAPI | undefined;
  readonly db: AnyDrizzleDb;
  readonly coverArtDir: string;
  private listeners: Set<SyncManagerListener>;
  syncInProgress: boolean;

  constructor(
    db: AnyDrizzleDb,
    options: {
      coverArtDir?: string;
    } = {},
  ) {
    this.db = db;
    this.coverArtDir = options.coverArtDir ?? join(process.cwd(), ".muswag", "album-covers");
    this.listeners = new Set();
    this.syncInProgress = false;
  }

  subscribe(listener: SyncManagerListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SyncEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (cause) {
        console.error("SyncManager subscriber failed", cause);
      }
    }
  }

  makeApi(credentials: UserStateToLogin) {
    return new SubsonicAPI({
      url: credentials.url,
      auth: {
        username: credentials.username,
        password: credentials.password,
      },
    });
  }

  async login(credentials: UserStateToLogin): Promise<UserState> {
    const api = this.makeApi(credentials);

    await verifyConnection(api);

    this.api = api;

    return storeUserCredentials(this.db, credentials);
  }

  async logout() {
    await this.db.delete(userCredentialsTable);
    return null;
  }

  async getUserState() {
    return userStateFromDB(this.db);
  }

  async sync() {
    const user = await this.getUserState();
    if (!user) {
      throw new Error("SyncManager.login() must be called before sync()");
    }

    this.api = this.makeApi(user);

    if (this.syncInProgress) {
      throw new Error("sync running already");
    }

    this.syncInProgress = true;

    const started = new Date();
    const startedAt = started.toISOString();

    this.emit({ type: "start", date: startedAt });

    try {
      const result = await syncAlbums(this);
      await storeLastSync(this.db, startedAt);
      return {
        ...result,
        startedAt,
      };
    } finally {
      this.syncInProgress = false;
      this.emit({ type: "end", date: new Date().toISOString() });
    }
  }
}

function getSubsonicRestBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const ensuredTrailingSlash = normalizedBaseUrl.endsWith("/") ? normalizedBaseUrl : `${normalizedBaseUrl}/`;

  if (ensuredTrailingSlash.endsWith("/rest/")) {
    return ensuredTrailingSlash;
  }

  return new URL("rest/", ensuredTrailingSlash).toString();
}
