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

  // This should probably use  db.playlists.cleanup() but currently is causes Unhandled Rejection on tests
  const playlistIds = [...db.playlists.keys()];
  if (playlistIds.length) db.playlists.delete(playlistIds);

  const songIds = [...db.songs.keys()];
  if (songIds.length) db.songs.delete(songIds);

  const albumIds = [...db.albums.keys()];
  if (albumIds.length) db.albums.delete(albumIds);

  const artistIds = [...db.artists.keys()];
  if (artistIds.length) db.artists.delete(artistIds);

  const syncIds = [...db.syncs.keys()];
  if (syncIds.length) db.syncs.delete(syncIds);

  const syncStateIds = [...db.syncState.keys()];
  if (syncStateIds.length) db.syncState.delete(syncStateIds);

  const playerQueueIds = [...db.playerQueue.keys()];
  if (playerQueueIds.length) db.playerQueue.delete(playerQueueIds);

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

export function buildSubsonicStreamUrl(md5: (v: string) => string, credentials: UserCredentialsToLogin, songId: string): string {
  const salt = randomHex(16);
  const token = md5(`${credentials.password}${salt}`);
  const url = new URL("stream.view", getSubsonicRestBaseUrl(credentials.url));

  url.searchParams
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
