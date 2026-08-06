import SubsonicAPI from "@muswag/subsonic-api";

import type { MuswagDb } from "./db/database.js";
import type { SyncRecord, UserCredentials } from "./db/types.js";
import { syncAlbums } from "./sync/sync-albums.js";
import { syncArtists } from "./sync/sync-artists.js";
import { createInitialSyncProgress, updateSyncProgress } from "./sync/progress.js";
import type { CoverManager } from "./covers/cover-manager.js";

const USER_CREDENTIALS_ROW_ID = 1;
const SUBSONIC_API_VERSION = "1.16.1";
const HEX = "0123456789abcdef";

export type UserInfo = { url: string; username: string; password: string } | null;
export type UserCredentialsToLogin = { url: string; username: string; password: string };
export type SyncInfo = SyncRecord | null;

export function createSubsonicApi(credentials: UserCredentialsToLogin) {
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
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
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
  const api = createSubsonicApi(credentials);
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

export async function logout(db: MuswagDb, covers?: CoverManager): Promise<null> {
  const existing = db.userCredentials.get(USER_CREDENTIALS_ROW_ID);
  if (existing) {
    db.userCredentials.delete(USER_CREDENTIALS_ROW_ID);
  }

  await db.playlists.cleanup();
  await db.songs.cleanup();
  await db.albums.cleanup();
  await db.artists.cleanup();
  await db.syncs.cleanup();
  await db.syncState.cleanup();
  await covers?.pruneOrphans();

  return null;
}

export type SyncMode = "full" | "quick";

export async function sync(db: MuswagDb, covers: CoverManager, options: { mode?: SyncMode; covers?: "background" | "inline" | "skip" } = {}): Promise<SyncRecord> {
  const user = getUserInfo(db);
  if (!user) {
    throw new Error("login() must be called before sync()");
  }

  const api = createSubsonicApi(user);

  const existingState = db.syncState.get(1);
  const requestedMode = options.mode ?? "quick";
  const mode: SyncMode = db.albums.size === 0 || !existingState || existingState.indexesLastModified === null ? "full" : requestedMode;
  const coverMode = options.covers ?? "background";

  const syncId = randomHex(16);
  const timeStarted = new Date().toISOString();

  const syncRecord: SyncRecord = {
    id: syncId,
    timeStarted,
    timeEnded: null,
    lastStatus: "running",
    error: null,
    mode,
    currentStep: "starting",
    progress: createInitialSyncProgress(),
    progressUpdatedAt: timeStarted,
  };
  db.syncs.insert(syncRecord);

  try {
    const artists = await syncArtists({
      api,
      db,
      syncId,
      ...(mode === "quick" && existingState?.indexesLastModified !== null && existingState?.indexesLastModified !== undefined ? { ifModifiedSince: existingState.indexesLastModified } : {}),
    });
    const albums = await syncAlbums({ api, db, syncId, mode });

    await Promise.all([...albums.deletedAlbumIds.map((id) => covers.remove({ type: "album", id })), ...artists.deletedArtistIds.map((id) => covers.remove({ type: "artist", id }))]);

    if (coverMode === "inline") {
      updateSyncProgress(db, syncId, { currentStep: "fetching-cover-art" });
      await covers.sweep({
        onProgress: (done, total) => {
          updateSyncProgress(db, syncId, { progress: { coverArtFetched: done, coverArtTotal: total } });
        },
      });
      if (mode === "full") await covers.pruneOrphans();
    } else if (coverMode === "skip" && mode === "full") {
      await covers.pruneOrphans();
    }

    const finishedAt = new Date().toISOString();
    const nextState = {
      id: 1,
      indexesLastModified: artists.lastModified ?? existingState?.indexesLastModified ?? null,
      lastFullSyncAt: mode === "full" ? finishedAt : (existingState?.lastFullSyncAt ?? null),
      lastQuickSyncAt: mode === "quick" ? finishedAt : (existingState?.lastQuickSyncAt ?? null),
    };
    if (existingState) {
      db.syncState.update(1, (draft) => Object.assign(draft, nextState));
    } else {
      db.syncState.insert(nextState);
    }

    db.syncs.update(syncId, (draft) => {
      draft.timeEnded = new Date().toISOString();
      draft.lastStatus = "completed";
      draft.currentStep = mode === "quick" && !artists.libraryChanged && albums.detailRequests === 0 && albums.deleted === 0 ? "skipped-unchanged" : "completed";
      draft.progressUpdatedAt = draft.timeEnded;
    });

    if (coverMode === "background") {
      void covers
        .sweep()
        .then(async () => {
          if (mode === "full") await covers.pruneOrphans();
        })
        .catch((error: unknown) => {
          console.warn("Background cover sweep failed.", { error });
        });
    }

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

export { createCoverArtStore } from "./covers/covers-helper.js";
export type { CoverArtFileSystem } from "./covers/covers-helper.js";
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
  // mpv can decode the source formats itself. A live transcode is commonly sent as
  // an unknown-length response, which mpv cannot finish reading early enough to
  // prefetch the next playlist entry for gapless playback.
  url.searchParams.set("format", "raw");
  url.searchParams.set("maxBitRate", "0");
  url.searchParams.set("estimateContentLength", "true");

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
