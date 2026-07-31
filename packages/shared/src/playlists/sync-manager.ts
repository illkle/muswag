import SubsonicAPI from "@muswag/subsonic-api";
import type { PlaylistWithSongs } from "@muswag/subsonic-api";
import { queryOnce } from "@tanstack/db";

import type { MuswagDb } from "../db/database.js";
import { getUserInfo } from "../syncManager.js";
import { hasPendingLocalChanges, mergePlaylists } from "./merge.js";
import type { PlaylistRecord, PlaylistState, RemotePlaylist, RemotePlaylistMutation } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60_000;
const DEFAULT_FETCH_CONCURRENCY = 5;

export interface PlaylistSyncStatus {
  state: "idle" | "scheduled" | "syncing" | "paused" | "error";
  error: string | null;
  lastSyncedAt: string | null;
}

type PlaylistApi = Pick<SubsonicAPI, "getPlaylists" | "getPlaylist" | "createPlaylist" | "updatePlaylist" | "deletePlaylist">;

export interface PlaylistSyncManagerOptions {
  debounceMs?: number;
  intervalMs?: number;
  /** First retry delay after a failed pass. Doubles per consecutive failure up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Concurrent `getPlaylist` requests per pass. */
  fetchConcurrency?: number;
  /**
   * The API must be able to POST: a playlist replacement sends every song index and id, which
   * overruns URL length limits on large playlists.
   */
  apiFactory?: (credentials: { url: string; username: string; password: string }, signal: AbortSignal) => PlaylistApi;
}

export interface PlaylistSyncManager {
  getStatus(): PlaylistSyncStatus;
  subscribe(listener: (status: PlaylistSyncStatus) => void): () => void;
  /** Runs a pass (or joins the one in flight) and resolves with the resulting status. Never rejects. */
  sync(): Promise<PlaylistSyncStatus>;
  pause(): void;
  resume(): void;
  cancel(): void;
  destroy(): void;
}

function defaultApiFactory(credentials: { url: string; username: string; password: string }, signal: AbortSignal): PlaylistApi {
  return new SubsonicAPI({
    url: credentials.url,
    auth: { username: credentials.username, password: credentials.password },
    post: true,
    fetch: (input, init) => fetch(input, { ...init, signal }),
  });
}

/**
 * Most servers (Navidrome included) never send `readonly`, so ownership is what actually decides
 * whether we may edit a playlist. A playlist with no owner is treated as ours.
 */
function isReadonlyForUser(playlist: { owner?: string | undefined; readonly?: boolean | undefined }, currentUsername: string): boolean {
  if (playlist.readonly === true) return true;
  if (playlist.owner === undefined) return false;
  return playlist.owner.toLowerCase() !== currentUsername.toLowerCase();
}

function toRemotePlaylist(playlist: PlaylistWithSongs, currentUsername: string): RemotePlaylist {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? "",
    public: playlist.public ?? false,
    readonly: isReadonlyForUser(playlist, currentUsername),
    songIds: (playlist.entry ?? []).map(({ id }) => id),
    ...(playlist.owner !== undefined && { owner: playlist.owner }),
    created: playlist.created,
    changed: playlist.changed,
    duration: playlist.duration,
    ...(playlist.coverArt !== undefined && { coverArt: playlist.coverArt }),
    ...(playlist.allowedUser !== undefined && { allowedUser: playlist.allowedUser }),
    ...(playlist.validUntil !== undefined && { validUntil: playlist.validUntil }),
  };
}

/** Rebuilds the remote view of an unchanged playlist from its last-synced snapshot, skipping a request. */
function baseToRemotePlaylist(serverId: string, base: PlaylistState): RemotePlaylist {
  return {
    id: serverId,
    name: base.name,
    comment: base.comment,
    public: base.public,
    readonly: base.readonly,
    songIds: base.entries.map(({ songId }) => songId),
    ...(base.owner !== undefined && { owner: base.owner }),
    ...(base.created !== undefined && { created: base.created }),
    ...(base.changed !== undefined && { changed: base.changed }),
    ...(base.duration !== undefined && { duration: base.duration }),
    ...(base.coverArt !== undefined && { coverArt: base.coverArt }),
    ...(base.allowedUser !== undefined && { allowedUser: base.allowedUser }),
    ...(base.validUntil !== undefined && { validUntil: base.validUntil }),
  };
}

/**
 * Snapshots of playlists that are fully in sync, keyed by server id. Anything with local work pending
 * is left out so it always gets refetched.
 */
function reusableBases(records: readonly PlaylistRecord[]): Map<string, PlaylistState> {
  const bases = new Map<string, PlaylistState>();
  for (const record of records) {
    if (record.serverId === null || record.base === null) continue;
    if (hasPendingLocalChanges(record)) continue;
    bases.set(record.serverId, record.base);
  }
  return bases;
}

function matchesSummary(base: PlaylistState, summary: { changed: string; songCount: number }): boolean {
  return base.changed === summary.changed && base.entries.length === summary.songCount;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;

  const worker = async () => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await run(items[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * `reusable` is empty for full passes (startup, interval, manual sync), which self-heals anything the
 * `changed` timestamp missed — it has second granularity, so two edits inside one second can look equal.
 */
async function fetchRemotePlaylists(
  api: PlaylistApi,
  currentUsername: string,
  concurrency: number,
  reusable: ReadonlyMap<string, PlaylistState>,
): Promise<RemotePlaylist[]> {
  const summaries = (await api.getPlaylists()).playlists.playlist ?? [];

  return mapWithConcurrency(summaries, concurrency, async (summary) => {
    const base = reusable.get(summary.id);
    if (base && matchesSummary(base, summary)) {
      return baseToRemotePlaylist(summary.id, base);
    }
    return toRemotePlaylist((await api.getPlaylist({ id: summary.id })).playlist, currentUsername);
  });
}

async function readLocalPlaylists(db: MuswagDb): Promise<PlaylistRecord[]> {
  const rows = await queryOnce((query) => query.from({ playlist: db.playlists }));
  return rows.map(({ id, serverId, base, local, revision }) => ({ id, serverId, base, local, revision }));
}

function sameRecord(left: PlaylistRecord, right: PlaylistRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyLocalState(db: MuswagDb, playlists: readonly PlaylistRecord[]): void {
  const expectedIds = new Set(playlists.map(({ id }) => id));

  for (const playlist of playlists) {
    const current = db.playlists.get(playlist.id);
    if (!current) {
      db.playlists.insert(playlist);
      continue;
    }
    const plainCurrent: PlaylistRecord = {
      id: current.id,
      serverId: current.serverId,
      base: current.base,
      local: current.local,
      revision: current.revision,
    };
    if (sameRecord(plainCurrent, playlist)) continue;

    db.playlists.update(playlist.id, (draft) => {
      draft.serverId = playlist.serverId;
      draft.base = playlist.base;
      draft.local = playlist.local;
      draft.revision = playlist.revision;
    });
  }

  for (const [id] of db.playlists.entries()) {
    if (!expectedIds.has(id)) {
      db.playlists.delete(id);
    }
  }
}

function songIds(state: PlaylistState): string[] {
  return state.entries.map(({ songId }) => songId);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRemoteVersion(left: RemotePlaylist, right: RemotePlaylist): boolean {
  return (
    left.name === right.name &&
    left.comment === right.comment &&
    left.public === right.public &&
    left.readonly === right.readonly &&
    left.owner === right.owner &&
    left.changed === right.changed &&
    sameStringArray(left.songIds, right.songIds)
  );
}

/**
 * Records the state we just pushed as the new `base`, because the server now holds it.
 *
 * Without this the pushed entries stay absent from `base`, so on the verification pass
 * `reconcileRemoteEntries` cannot match them and mints fresh `remote:` ids. The merge then sees the
 * local entry and the server's echo of that same entry as two independent additions and keeps both,
 * re-pushing a longer playlist every pass. If the push did not land exactly, the verification fetch
 * re-merges against the real remote state and corrects this.
 */
function commitPushedBase(db: MuswagDb, localId: string, state: PlaylistState, suppressed: (write: () => void) => void): void {
  if (!db.playlists.get(localId)) return;

  suppressed(() => {
    db.playlists.update(localId, (draft) => {
      draft.base = state;
    });
  });
}

async function executeRemoteMutation(
  db: MuswagDb,
  api: PlaylistApi,
  mutation: RemotePlaylistMutation,
  currentUsername: string,
  suppressed: (write: () => void) => void,
): Promise<"applied" | "stale"> {
  switch (mutation.type) {
    case "create": {
      const created = await api.createPlaylist({ name: mutation.state.name, songId: songIds(mutation.state) });
      const playlist = db.playlists.get(mutation.localId);
      if (playlist?.serverId === null) {
        suppressed(() => {
          db.playlists.update(mutation.localId, (draft) => {
            draft.serverId = created.playlist.id;
          });
        });
      }
      await api.updatePlaylist({
        playlistId: created.playlist.id,
        name: mutation.state.name,
        comment: mutation.state.comment,
        public: mutation.state.public,
      });
      commitPushedBase(db, mutation.localId, mutation.state, suppressed);
      return "applied";
    }

    case "replace": {
      const nextSongIds = songIds(mutation.state);
      const entriesChanged = !sameStringArray(nextSongIds, mutation.expected.songIds);
      let previousSongCount = mutation.expected.songIds.length;

      // Subsonic has no conditional update operation. Re-reading immediately before a destructive
      // replacement narrows the race and, crucially, avoids applying indices from an older version.
      if (entriesChanged) {
        const latest = toRemotePlaylist((await api.getPlaylist({ id: mutation.serverId })).playlist, currentUsername);
        if (!sameRemoteVersion(latest, mutation.expected)) return "stale";
        previousSongCount = latest.songIds.length;
      }

      await api.updatePlaylist({
        playlistId: mutation.serverId,
        name: mutation.state.name,
        comment: mutation.state.comment,
        public: mutation.state.public,
        ...(entriesChanged && {
          songIndexToRemove: Array.from({ length: previousSongCount }, (_, index) => previousSongCount - index - 1),
          songIdToAdd: nextSongIds,
        }),
      });
      commitPushedBase(db, mutation.localId, mutation.state, suppressed);
      return "applied";
    }

    case "delete":
      await api.deletePlaylist({ id: mutation.serverId });
      return "applied";
  }
}

function sameCredentials(
  left: { url: string; username: string; password: string } | null,
  right: { url: string; username: string; password: string } | null,
): boolean {
  return left?.url === right?.url && left?.username === right?.username && left?.password === right?.password;
}

function assertCredentials(db: MuswagDb, expected: { url: string; username: string; password: string }): void {
  if (sameCredentials(expected, getUserInfo(db))) return;

  const error = new Error("Playlist sync cancelled because credentials changed");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError";
}

export function createPlaylistSyncManager(db: MuswagDb, options: PlaylistSyncManagerOptions = {}): PlaylistSyncManager {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
  const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
  const apiFactory = options.apiFactory ?? defaultApiFactory;
  const listeners = new Set<(status: PlaylistSyncStatus) => void>();
  let status: PlaylistSyncStatus = { state: "idle", error: null, lastSyncedAt: null };
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let syncInFlight: Promise<PlaylistSyncStatus> | undefined;
  let abortController: AbortController | undefined;
  let rerunRequested = false;
  let retryAfter: number | undefined;
  let retryDelay = retryMs;
  /** Startup refetches everything; edit-triggered passes may reuse unchanged snapshots. */
  let fullNextPass = true;
  let paused = false;
  let destroyed = false;
  let applyingLocalState = false;

  const setStatus = (next: PlaylistSyncStatus) => {
    status = next;
    for (const listener of listeners) listener(status);
  };

  const clearScheduled = () => {
    if (scheduled) clearTimeout(scheduled);
    scheduled = undefined;
  };

  const schedule = (delay: number, full = false) => {
    if (full) fullNextPass = true;
    if (destroyed || paused || !getUserInfo(db)) return;
    if (syncInFlight) {
      rerunRequested = true;
      return;
    }
    clearScheduled();
    setStatus({ ...status, state: "scheduled" });
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void startSync();
    }, delay);
  };

  const runPass = async (full: boolean) => {
    const credentials = getUserInfo(db);
    if (!credentials) return;

    abortController = new AbortController();
    const api = apiFactory(credentials, abortController.signal);

    const fetchPlaylists = async (forceIds: ReadonlySet<string> = new Set()) => {
      // Records with pending local work are never reused, so a mutated playlist is always verified.
      const reusable = full ? new Map<string, PlaylistState>() : reusableBases(await readLocalPlaylists(db));
      for (const serverId of forceIds) reusable.delete(serverId);
      return fetchRemotePlaylists(api, credentials.username, fetchConcurrency, reusable);
    };

    // Sync's own writes must not re-trigger the debounce, or every pass schedules another one.
    const suppressed = (write: () => void) => {
      try {
        applyingLocalState = true;
        write();
      } finally {
        applyingLocalState = false;
      }
    };

    const applyMerged = (local: readonly PlaylistRecord[]) => {
      suppressed(() => applyLocalState(db, local));
    };

    let remote = await fetchPlaylists();
    assertCredentials(db, credentials);

    let merged = mergePlaylists(await readLocalPlaylists(db), remote);
    applyMerged(merged.local);

    const mutatedServerIds = new Set<string>();
    for (const mutation of merged.remote) {
      assertCredentials(db, credentials);
      const result = await executeRemoteMutation(db, api, mutation, credentials.username, suppressed);
      if (result === "stale") rerunRequested = true;
      if (mutation.type === "create") {
        const serverId = db.playlists.get(mutation.localId)?.serverId;
        if (serverId) mutatedServerIds.add(serverId);
      } else {
        mutatedServerIds.add(mutation.serverId);
      }
    }

    if (merged.remote.length > 0) {
      // Never verify a write from `base`: servers may normalize or reject parts of an update while
      // still returning success, and a stale mutation needs the actual latest remote state.
      remote = await fetchPlaylists(mutatedServerIds);
      assertCredentials(db, credentials);
      merged = mergePlaylists(await readLocalPlaylists(db), remote);
      applyMerged(merged.local);
      if (merged.remote.length > 0) rerunRequested = true;
    }
  };

  const startSync = (): Promise<PlaylistSyncStatus> => {
    if (syncInFlight) {
      rerunRequested = true;
      return syncInFlight;
    }
    if (!getUserInfo(db) || destroyed) return Promise.resolve(status);

    clearScheduled();
    setStatus({ ...status, state: "syncing", error: null });

    const full = fullNextPass;
    fullNextPass = false;
    // Captured before the retry scheduling in `finally` overwrites the state with "scheduled".
    let passStatus = status;

    syncInFlight = runPass(full)
      .then(() => {
        retryDelay = retryMs;
        setStatus({ state: paused ? "paused" : "idle", error: null, lastSyncedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          setStatus({ ...status, state: paused ? "paused" : "idle", error: null });
          return;
        }
        setStatus({ ...status, state: "error", error: error instanceof Error ? error.message : String(error) });
        retryAfter = retryDelay;
        retryDelay = Math.min(retryDelay * 2, maxRetryMs);
        fullNextPass = true;
      })
      .then(() => {
        passStatus = status;
      })
      .finally(() => {
        syncInFlight = undefined;
        abortController = undefined;
        if (retryAfter !== undefined) {
          const delay = retryAfter;
          retryAfter = undefined;
          rerunRequested = false;
          schedule(delay);
          return;
        }
        if (rerunRequested) {
          rerunRequested = false;
          schedule(0);
        }
      })
      .then(() => passStatus);

    return syncInFlight;
  };

  const playlistSubscription = db.playlists.subscribeChanges(
    () => {
      if (!applyingLocalState) schedule(debounceMs);
    },
    { includeInitialState: false },
  );

  const credentialsSubscription = db.userCredentials.subscribeChanges(
    () => {
      if (!getUserInfo(db)) {
        clearScheduled();
        abortController?.abort();
        setStatus({ ...status, state: "idle", error: null });
        return;
      }
      schedule(0, true);
    },
    { includeInitialState: false },
  );

  const interval = intervalMs > 0 ? setInterval(() => schedule(0, true), intervalMs) : undefined;
  if (interval && typeof interval === "object" && "unref" in interval) interval.unref();
  void queryOnce((query) => query.from({ credentials: db.userCredentials })).then(() => {
    if (!destroyed && !paused) void startSync();
  });

  return {
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync() {
      fullNextPass = true;
      return startSync();
    },
    pause() {
      paused = true;
      clearScheduled();
      abortController?.abort();
      setStatus({ ...status, state: "paused", error: null });
    },
    resume() {
      paused = false;
      schedule(0, true);
    },
    cancel() {
      abortController?.abort();
    },
    destroy() {
      destroyed = true;
      clearScheduled();
      abortController?.abort();
      if (interval) clearInterval(interval);
      playlistSubscription.unsubscribe();
      credentialsSubscription.unsubscribe();
      listeners.clear();
    },
  };
}
