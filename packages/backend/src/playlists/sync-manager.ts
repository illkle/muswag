import { playlists, type PlaylistRecord, type PlaylistState, type PlaylistSyncStatus, type PlaylistWithSongs, type RemotePlaylist, type RemotePlaylistMutation } from "@muswag/model";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";

import SubsonicAPI, { type SubsonicApiService } from "../api/subsonic-api.js";
import { Db, type Database, write } from "../db/database.js";
import { PlaylistEdits } from "./commands.js";
import { hasPendingLocalChanges, mergePlaylists } from "./merge.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60_000;
const DEFAULT_FETCH_CONCURRENCY = 5;

type PlaylistApi = Pick<SubsonicApiService, "getPlaylists" | "getPlaylist" | "createPlaylist" | "updatePlaylist" | "deletePlaylist">;
type SyncRequest = { readonly full: boolean; readonly result?: Deferred.Deferred<PlaylistSyncStatus> };

export interface PlaylistSyncManagerOptions {
  debounceMs?: number;
  intervalMs?: number;
  /** First retry delay after a failed pass. Doubles per consecutive failure up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Concurrent `getPlaylist` effects per pass. */
  fetchConcurrency?: number;
}

export interface PlaylistSyncManagerService {
  readonly getStatus: Effect.Effect<PlaylistSyncStatus>;
  readonly subscribe: (listener: (status: PlaylistSyncStatus) => void) => Effect.Effect<() => void>;
  /** Queues a full pass. Failures are reflected in the returned status. */
  readonly sync: Effect.Effect<PlaylistSyncStatus>;
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  readonly cancel: Effect.Effect<void>;
}

export class PlaylistSyncManager extends Context.Service<PlaylistSyncManager, PlaylistSyncManagerService>()("@muswag/backend/PlaylistSyncManager") {}

export const PlaylistSyncManagerLive = (options: PlaylistSyncManagerOptions = {}) => Layer.effect(PlaylistSyncManager, makePlaylistSyncManager(options));

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
    ...(playlist.allowedUser !== undefined && { allowedUser: [...playlist.allowedUser] }),
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

/**
 * `reusable` is empty for full passes (startup, interval, manual sync), which self-heals anything the
 * `changed` timestamp missed — it has second granularity, so two edits inside one second can look equal.
 */
function fetchRemotePlaylists(api: PlaylistApi, currentUsername: string, concurrency: number, reusable: ReadonlyMap<string, PlaylistState>) {
  return Effect.gen(function* () {
    const summaries = (yield* api.getPlaylists).playlists.playlist ?? [];

    return yield* Effect.all(
      summaries.map((summary) => {
        const base = reusable.get(summary.id);
        if (base && matchesSummary(base, summary)) {
          return Effect.succeed(baseToRemotePlaylist(summary.id, base));
        }
        return api.getPlaylist({ id: summary.id }).pipe(Effect.map(({ playlist }) => toRemotePlaylist(playlist, currentUsername)));
      }),
      { concurrency: Math.max(1, concurrency) },
    );
  });
}

function readLocalPlaylists(db: Database) {
  return db.select().from(playlists);
}

function sameRecord(left: PlaylistRecord, right: PlaylistRecord): boolean {
  const plain = ({ id, serverId, base, local, revision }: PlaylistRecord) => ({ id, serverId, base, local, revision });
  return JSON.stringify(plain(left)) === JSON.stringify(plain(right));
}

/** Saves the merged playlists, touching only rows that changed. Runs inside the caller's transaction. */
function applyLocalState(db: Database, records: readonly PlaylistRecord[]) {
  return Effect.gen(function* () {
    const current = new Map((yield* readLocalPlaylists(db)).map((record) => [record.id, record]));
    for (const record of records) {
      const existing = current.get(record.id);
      current.delete(record.id);
      if (existing && sameRecord(existing, record)) continue;
      const { id, ...values } = record;
      if (existing) yield* db.update(playlists).set(values).where(eq(playlists.id, id));
      else yield* db.insert(playlists).values(record);
    }
    if (current.size > 0) yield* db.delete(playlists).where(inArray(playlists.id, [...current.keys()]));
  });
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
function commitPushedBase(db: Database, localId: string, state: PlaylistState) {
  return write(db.update(playlists).set({ base: state }).where(eq(playlists.id, localId)));
}

function executeRemoteMutation(db: Database, api: PlaylistApi, mutation: RemotePlaylistMutation, currentUsername: string) {
  return Effect.gen(function* () {
    switch (mutation.type) {
      case "create": {
        const created = yield* api.createPlaylist({ name: mutation.state.name, songId: songIds(mutation.state) });
        // Only a still-unattached record takes the id; the user may have deleted it meanwhile.
        yield* write(
          db
            .update(playlists)
            .set({ serverId: created.playlist.id })
            .where(and(eq(playlists.id, mutation.localId), isNull(playlists.serverId))),
        );
        yield* api.updatePlaylist({
          playlistId: created.playlist.id,
          name: mutation.state.name,
          comment: mutation.state.comment,
          public: mutation.state.public,
        });
        yield* commitPushedBase(db, mutation.localId, mutation.state);
        return "applied" as const;
      }

      case "replace": {
        const nextSongIds = songIds(mutation.state);
        const entriesChanged = !sameStringArray(nextSongIds, mutation.expected.songIds);
        let previousSongCount = mutation.expected.songIds.length;

        // Subsonic has no conditional update operation. Re-reading immediately before a destructive
        // replacement narrows the race and, crucially, avoids applying indices from an older version.
        if (entriesChanged) {
          const latest = toRemotePlaylist((yield* api.getPlaylist({ id: mutation.serverId })).playlist, currentUsername);
          if (!sameRemoteVersion(latest, mutation.expected)) return "stale" as const;
          previousSongCount = latest.songIds.length;
        }

        yield* api.updatePlaylist({
          playlistId: mutation.serverId,
          name: mutation.state.name,
          comment: mutation.state.comment,
          public: mutation.state.public,
          ...(entriesChanged && {
            songIndexToRemove: Array.from({ length: previousSongCount }, (_, index) => previousSongCount - index - 1),
            songIdToAdd: nextSongIds,
          }),
        });
        yield* commitPushedBase(db, mutation.localId, mutation.state);
        return "applied" as const;
      }

      case "delete":
        yield* api.deletePlaylist({ id: mutation.serverId });
        return "applied" as const;
    }
  });
}

const makePlaylistSyncManager = (options: PlaylistSyncManagerOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const api = yield* SubsonicAPI;
    const edits = yield* PlaylistEdits;
    const scope = yield* Effect.scope;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
    const requests = yield* Queue.unbounded<SyncRequest>();
    const waiters = new Set<Deferred.Deferred<PlaylistSyncStatus>>();
    const listeners = new Set<(status: PlaylistSyncStatus) => void>();
    let status: PlaylistSyncStatus = { state: "idle", error: null, lastSyncedAt: null };
    let scheduled: Fiber.Fiber<void> | undefined;
    let currentPass: Fiber.Fiber<boolean, unknown> | undefined;
    let currentRequest: SyncRequest | undefined;
    let interval: Fiber.Fiber<never> | undefined;
    let retryDelay = retryMs;
    let paused = false;

    const setStatus = (next: PlaylistSyncStatus) => {
      status = next;
      for (const listener of listeners) listener(status);
    };

    const clearScheduled = Effect.suspend(() => {
      const current = scheduled;
      scheduled = undefined;
      return current ? Fiber.interrupt(current) : Effect.void;
    });

    const enqueue = (request: SyncRequest) => Queue.offer(requests, request).pipe(Effect.asVoid);

    const requestSync = (full: boolean) =>
      Effect.gen(function* () {
        const result = yield* Deferred.make<PlaylistSyncStatus>();
        waiters.add(result);
        yield* enqueue({ full, result });
        return yield* Deferred.await(result).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiters.delete(result);
            }),
          ),
        );
      });

    const schedule = (delay: number, full = false): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (paused) return;

        yield* clearScheduled;
        if (!currentPass) setStatus({ ...status, state: "scheduled" });
        const fiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              Effect.sync(() => {
                scheduled = undefined;
              }),
            ),
            Effect.andThen(requestSync(full)),
            Effect.asVoid,
          ),
          scope,
          { startImmediately: false },
        );
        scheduled = fiber;
      });

    const runPass = (full: boolean) =>
      Effect.gen(function* () {
        let needsRerun = false;

        const fetchPlaylists = (forceIds: ReadonlySet<string> = new Set()) =>
          Effect.gen(function* () {
            // Records with pending local work are never reused, so a mutated playlist is always verified.
            const reusable = full ? new Map<string, PlaylistState>() : reusableBases(yield* readLocalPlaylists(db));
            for (const serverId of forceIds) reusable.delete(serverId);
            return yield* fetchRemotePlaylists(api, api.username, fetchConcurrency, reusable);
          });

        // Reading local state, merging and saving happen in one transaction, so a local edit cannot
        // land between the read and the save and be overwritten.
        const mergeAndApply = (remote: readonly RemotePlaylist[]) =>
          write(
            Effect.gen(function* () {
              const merged = mergePlaylists(yield* readLocalPlaylists(db), remote);
              yield* applyLocalState(db, merged.local);
              return merged;
            }),
          );

        let remote = yield* fetchPlaylists();
        let merged = yield* mergeAndApply(remote);

        const mutatedServerIds = new Set<string>();
        for (const mutation of merged.remote) {
          const result = yield* executeRemoteMutation(db, api, mutation, api.username);
          if (result === "stale") needsRerun = true;
          if (mutation.type === "create") {
            const [record] = yield* db.select({ serverId: playlists.serverId }).from(playlists).where(eq(playlists.id, mutation.localId));
            if (record?.serverId) mutatedServerIds.add(record.serverId);
          } else {
            mutatedServerIds.add(mutation.serverId);
          }
        }

        if (merged.remote.length > 0) {
          // Never verify a write from `base`: servers may normalize or reject parts of an update while
          // still returning success, and a stale mutation needs the actual latest remote state.
          remote = yield* fetchPlaylists(mutatedServerIds);
          merged = yield* mergeAndApply(remote);
          if (merged.remote.length > 0) needsRerun = true;
        }

        return needsRerun;
      });

    const processRequest = (request: SyncRequest) =>
      Effect.gen(function* () {
        currentRequest = request;
        if (paused) {
          if (request.result) yield* Deferred.succeed(request.result, status);
          currentRequest = undefined;
          return;
        }

        setStatus({ ...status, state: "syncing", error: null });
        const fiber = yield* Effect.forkIn(runPass(request.full), scope, { startImmediately: false });
        currentPass = fiber;
        const exit = yield* Fiber.await(fiber);
        currentPass = undefined;

        let needsRerun = false;
        let retryAfter: number | undefined;
        if (Exit.isSuccess(exit)) {
          needsRerun = exit.value;
          retryDelay = retryMs;
          setStatus({ state: paused ? "paused" : "idle", error: null, lastSyncedAt: new Date().toISOString() });
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          setStatus({ ...status, state: paused ? "paused" : "idle", error: null });
        } else {
          const error = Cause.squash(exit.cause);
          setStatus({ ...status, state: "error", error: error instanceof Error ? error.message : String(error) });
          retryAfter = retryDelay;
          retryDelay = Math.min(retryDelay * 2, maxRetryMs);
        }

        // Scheduling a follow-up changes the public state, but callers need the result of this pass.
        const passStatus = status;
        if (retryAfter !== undefined) yield* schedule(retryAfter, true);
        else if (needsRerun) yield* enqueue({ full: false });
        if (request.result) yield* Deferred.succeed(request.result, passStatus);
        currentRequest = undefined;
      });

    yield* Effect.forkIn(Effect.forever(Queue.take(requests).pipe(Effect.flatMap(processRequest))), scope);

    // Local edits come from the playlist commands; sync's own writes are not announced.
    yield* Effect.forkIn(
      Stream.runForEach(edits.stream, () => schedule(debounceMs)),
      scope,
    );

    if (intervalMs > 0) {
      interval = yield* Effect.forkIn(Effect.forever(Effect.sleep(intervalMs).pipe(Effect.andThen(schedule(0, true)))), scope);
    }

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* clearScheduled;
        if (currentPass) yield* Fiber.interrupt(currentPass);
        if (interval) yield* Fiber.interrupt(interval);
        const finalStatus: PlaylistSyncStatus = { ...status, state: "idle" };
        if (currentRequest?.result) yield* Deferred.succeed(currentRequest.result, finalStatus);
        currentRequest = undefined;
        for (const waiter of waiters) {
          yield* Deferred.succeed(waiter, finalStatus);
        }
        waiters.clear();
        listeners.clear();
      }),
    );

    yield* Effect.forkIn(
      Effect.suspend(() => (currentPass || Queue.sizeUnsafe(requests) > 0 || status.lastSyncedAt ? Effect.void : schedule(0, true))),
      scope,
    );

    return {
      getStatus: Effect.sync(() => status),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
      sync: Effect.gen(function* () {
        yield* clearScheduled;
        return yield* requestSync(true);
      }),
      pause: Effect.gen(function* () {
        paused = true;
        yield* clearScheduled;
        if (currentPass) yield* Fiber.interrupt(currentPass);
        setStatus({ ...status, state: "paused", error: null });
      }),
      resume: Effect.suspend(() => {
        paused = false;
        return schedule(0, true);
      }),
      cancel: Effect.suspend(() => (currentPass ? Fiber.interrupt(currentPass) : Effect.void)),
    } satisfies PlaylistSyncManagerService;
  });
