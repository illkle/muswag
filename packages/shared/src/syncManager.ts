import SubsonicAPI from "@muswag/subsonic-api";

import type { MuswagDb } from "./db/database.js";
import type { SyncRecord, UserCredentials } from "./db/types.js";
import { syncAlbums } from "./sync/sync-albums.js";
import { createInitialSyncProgress } from "./sync/progress.js";
import type { CoverArtStore } from "./sync/utils.js";

const USER_CREDENTIALS_ROW_ID = 1;
const SUBSONIC_API_VERSION = "1.16.1";
const HEX = "0123456789abcdef";

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

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let output = "";
  for (const byte of bytes) {
    output += HEX[byte >>> 4] ?? "0";
    output += HEX[byte & 0x0f] ?? "0";
  }
  return output;
}

function rotateLeft(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

function add32(...values: number[]): number {
  return values.reduce((sum, value) => (sum + value) >>> 0, 0);
}

function md5(input: string): string {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 8) >>> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;

      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }

      const next = d;
      d = c;
      c = b;
      b = add32(b, rotateLeft(add32(a, f, constants[index] ?? 0, view.getUint32(offset + g * 4, true)), shifts[index] ?? 0));
      a = next;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  return [a0, b0, c0, d0]
    .map((word) => {
      let output = "";
      for (let index = 0; index < 4; index += 1) {
        const byte = (word >>> (index * 8)) & 0xff;
        output += HEX[byte >>> 4] ?? "0";
        output += HEX[byte & 0x0f] ?? "0";
      }
      return output;
    })
    .join("");
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

  const syncId = randomHex(16);
  const timeStarted = new Date().toISOString();

  const syncRecord: SyncRecord = {
    id: syncId,
    timeStarted,
    timeEnded: null,
    lastStatus: "running",
    error: null,
    currentStep: "starting",
    progress: createInitialSyncProgress(),
    progressUpdatedAt: timeStarted,
  };
  db.syncs.insert(syncRecord);

  try {
    await syncAlbums({ api, db, coverArt, syncId });

    db.syncs.update(syncId, (draft) => {
      draft.timeEnded = new Date().toISOString();
      draft.lastStatus = "completed";
      draft.currentStep = "completed";
      draft.progressUpdatedAt = draft.timeEnded;
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
      draft.currentStep = "failed";
      draft.progressUpdatedAt = draft.timeEnded;
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
        draft.currentStep = "aborted";
        draft.progressUpdatedAt = draft.timeEnded;
      });
    }
  }
}

// --- Helpers ---

export { createCoverArtStore } from "./sync/covers-helper.js";
export type { CoverArtFileSystem } from "./sync/covers-helper.js";
export { createInitialSyncProgress } from "./sync/progress.js";

export function buildSubsonicStreamUrl(credentials: UserCredentialsToLogin, songId: string): string {
  const salt = randomHex(16);
  const token = md5(`${credentials.password}${salt}`);
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
