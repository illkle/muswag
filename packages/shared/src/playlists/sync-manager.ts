import SubsonicAPI from "@muswag/subsonic-api";
import type { PlaylistWithSongs } from "@muswag/subsonic-api";
import { queryOnce } from "@tanstack/db";

import type { MuswagDb } from "../db/database.js";
import { getUserInfo } from "../syncManager.js";
import { mergePlaylists } from "./merge.js";
import type { PlaylistRecord, PlaylistState, RemotePlaylist, RemotePlaylistMutation } from "./types.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 5_000;

export interface PlaylistSyncStatus {
  state: "idle" | "scheduled" | "syncing" | "paused" | "error";
  error: string | null;
  lastSyncedAt: string | null;
}

type PlaylistApi = Pick<SubsonicAPI, "getPlaylists" | "getPlaylist" | "createPlaylist" | "updatePlaylist" | "deletePlaylist">;

export interface PlaylistSyncManagerOptions {
  debounceMs?: number;
  intervalMs?: number;
  retryMs?: number;
  apiFactory?: (credentials: { url: string; username: string; password: string }, signal: AbortSignal) => PlaylistApi;
}

export interface PlaylistSyncManager {
  getStatus(): PlaylistSyncStatus;
  subscribe(listener: (status: PlaylistSyncStatus) => void): () => void;
  sync(): Promise<void>;
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

function toRemotePlaylist(playlist: PlaylistWithSongs): RemotePlaylist {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? "",
    public: playlist.public ?? false,
    readonly: playlist.readonly ?? false,
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

async function fetchRemotePlaylists(api: PlaylistApi): Promise<RemotePlaylist[]> {
  const summaries = (await api.getPlaylists()).playlists.playlist ?? [];
  const playlists = await Promise.all(summaries.map(({ id }) => api.getPlaylist({ id })));
  return playlists.map(({ playlist }) => toRemotePlaylist(playlist));
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

async function executeRemoteMutation(db: MuswagDb, api: PlaylistApi, mutation: RemotePlaylistMutation): Promise<void> {
  switch (mutation.type) {
    case "create": {
      const created = await api.createPlaylist({ name: mutation.state.name, songId: songIds(mutation.state) });
      const playlist = db.playlists.get(mutation.localId);
      if (playlist?.serverId === null) {
        db.playlists.update(mutation.localId, (draft) => {
          draft.serverId = created.playlist.id;
        });
      }
      await api.updatePlaylist({
        playlistId: created.playlist.id,
        name: mutation.state.name,
        comment: mutation.state.comment,
        public: mutation.state.public,
      });
      return;
    }

    case "replace":
      await api.updatePlaylist({
        playlistId: mutation.serverId,
        name: mutation.state.name,
        comment: mutation.state.comment,
        public: mutation.state.public,
        songIndexToRemove: Array.from({ length: mutation.previousSongCount }, (_, index) => mutation.previousSongCount - index - 1),
        songIdToAdd: songIds(mutation.state),
      });
      return;

    case "delete":
      await api.deletePlaylist({ id: mutation.serverId });
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
  const apiFactory = options.apiFactory ?? defaultApiFactory;
  const listeners = new Set<(status: PlaylistSyncStatus) => void>();
  let status: PlaylistSyncStatus = { state: "idle", error: null, lastSyncedAt: null };
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let syncInFlight: Promise<void> | undefined;
  let abortController: AbortController | undefined;
  let rerunRequested = false;
  let retryAfter: number | undefined;
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

  const schedule = (delay: number) => {
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

  const runPass = async () => {
    const credentials = getUserInfo(db);
    if (!credentials) return;

    abortController = new AbortController();
    const api = apiFactory(credentials, abortController.signal);
    let remote = await fetchRemotePlaylists(api);
    assertCredentials(db, credentials);

    let merged = mergePlaylists(await readLocalPlaylists(db), remote);
    try {
      applyingLocalState = true;
      applyLocalState(db, merged.local);
    } finally {
      applyingLocalState = false;
    }

    for (const mutation of merged.remote) {
      assertCredentials(db, credentials);
      await executeRemoteMutation(db, api, mutation);
    }

    if (merged.remote.length > 0) {
      remote = await fetchRemotePlaylists(api);
      assertCredentials(db, credentials);
      merged = mergePlaylists(await readLocalPlaylists(db), remote);
      try {
        applyingLocalState = true;
        applyLocalState(db, merged.local);
      } finally {
        applyingLocalState = false;
      }
      if (merged.remote.length > 0) rerunRequested = true;
    }
  };

  const startSync = (): Promise<void> => {
    if (syncInFlight) {
      rerunRequested = true;
      return syncInFlight;
    }
    if (!getUserInfo(db) || destroyed) return Promise.resolve();

    clearScheduled();
    setStatus({ ...status, state: "syncing", error: null });
    syncInFlight = runPass()
      .then(() => {
        setStatus({ state: paused ? "paused" : "idle", error: null, lastSyncedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          setStatus({ ...status, state: paused ? "paused" : "idle", error: null });
          return;
        }
        setStatus({ ...status, state: "error", error: error instanceof Error ? error.message : String(error) });
        retryAfter = retryMs;
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
      });

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
      schedule(0);
    },
    { includeInitialState: false },
  );

  const interval = intervalMs > 0 ? setInterval(() => schedule(0), intervalMs) : undefined;
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
    sync: startSync,
    pause() {
      paused = true;
      clearScheduled();
      abortController?.abort();
      setStatus({ ...status, state: "paused", error: null });
    },
    resume() {
      paused = false;
      schedule(0);
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
