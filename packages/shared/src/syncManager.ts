import { createHash, randomBytes } from "node:crypto";

import SubsonicAPI from "subsonic-api";

import type { MuswagDb } from "./db/database.js";
import type { SyncRecord, UserCredentials } from "./db/types.js";
import { syncAlbums } from "./sync/sync-albums.js";
import type { CoverArtStore } from "./sync/utils.js";

const USER_CREDENTIALS_ROW_ID = 1;
const SUBSONIC_API_VERSION = "1.16.1";

export type UserInfo = { url: string; username: string; password: string } | null;
export type UserCredentialsToLogin = { url: string; username: string; password: string };
export type SyncInfo = SyncRecord | null;

function createApi(credentials: UserCredentialsToLogin) {
  return new SubsonicAPI({
    url: credentials.url,
    auth: {
      username: credentials.username,
      password: credentials.password,
    },
  });
}

async function verifyConnection(api: SubsonicAPI) {
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

// --- Read API ---

export function getUserInfo(db: MuswagDb): UserInfo {
  const row = db.userCredentials.get(USER_CREDENTIALS_ROW_ID);
  if (!row) return null;
  return {
    url: row.url,
    username: row.username,
    password: row.password,
  };
}

export function getSyncInfo(db: MuswagDb): SyncInfo {
  let latest: SyncRecord | null = null;
  for (const [, record] of db.syncs.entries()) {
    if (!latest || record.timeStarted > latest.timeStarted) {
      latest = record;
    }
  }
  return latest;
}

// --- Hooks ---

export async function login(db: MuswagDb, credentials: UserCredentialsToLogin): Promise<UserInfo> {
  const api = createApi(credentials);
  await verifyConnection(api);

  const existing = db.userCredentials.get(USER_CREDENTIALS_ROW_ID);
  const record: UserCredentials = {
    id: USER_CREDENTIALS_ROW_ID,
    url: credentials.url,
    username: credentials.username,
    password: credentials.password,
  };

  if (existing) {
    db.userCredentials.delete(USER_CREDENTIALS_ROW_ID);
  }
  db.userCredentials.insert(record);

  return { url: credentials.url, username: credentials.username, password: credentials.password };
}

export async function logout(db: MuswagDb): Promise<null> {
  const existing = db.userCredentials.get(USER_CREDENTIALS_ROW_ID);
  if (existing) {
    db.userCredentials.delete(USER_CREDENTIALS_ROW_ID);
  }
  return null;
}

export async function sync(db: MuswagDb, coverArt: CoverArtStore): Promise<SyncRecord> {
  const user = getUserInfo(db);
  if (!user) {
    throw new Error("login() must be called before sync()");
  }

  const api = createApi(user);

  const syncId = randomBytes(16).toString("hex");
  const timeStarted = new Date().toISOString();

  const syncRecord: SyncRecord = {
    id: syncId,
    timeStarted,
    timeEnded: null,
    lastStatus: "running",
    error: null,
  };
  db.syncs.insert(syncRecord);

  try {
    await syncAlbums({ api, db, coverArt, syncId });

    db.syncs.update(syncId, (draft) => {
      draft.timeEnded = new Date().toISOString();
      draft.lastStatus = "completed";
    });

    return db.syncs.get(syncId)!;
  } catch (error) {
    const record = db.syncs.get(syncId);
    // If timeEnded is already set, this was an abort
    if (record && record.timeEnded !== null) {
      return record;
    }

    db.syncs.update(syncId, (draft) => {
      draft.timeEnded = new Date().toISOString();
      draft.lastStatus = "failed";
      draft.error = error instanceof Error ? error.message : String(error);
    });

    throw error;
  }
}

export function abortSync(db: MuswagDb): void {
  for (const [, record] of db.syncs.entries()) {
    if (record.lastStatus === "running") {
      db.syncs.update(record.id, (draft) => {
        draft.timeEnded = new Date().toISOString();
        draft.lastStatus = "aborted";
      });
    }
  }
}

// --- Helpers ---

export { createCoverArtStore } from "./sync/covers-helper.js";

export function buildSubsonicStreamUrl(credentials: UserCredentialsToLogin, songId: string): string {
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

function getSubsonicRestBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const ensuredTrailingSlash = normalizedBaseUrl.endsWith("/") ? normalizedBaseUrl : `${normalizedBaseUrl}/`;

  if (ensuredTrailingSlash.endsWith("/rest/")) {
    return ensuredTrailingSlash;
  }

  return new URL("rest/", ensuredTrailingSlash).toString();
}
