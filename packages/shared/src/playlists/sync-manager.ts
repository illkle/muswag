import { Cause, Context, Effect, Exit, Fiber, FiberHandle, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import { queryOnce } from "@tanstack/db";

import SubsonicAPI, { type SubsonicApiService, type SubsonicClientError } from "../api/subsonic-api.js";
import type { PlaylistWithSongs } from "../api/subsonic-api-schema.js";
import { MuswagDatabase, type MuswagDb } from "../db/database.js";
import { hasPendingLocalChanges, mergePlaylists } from "./merge.js";
import type { PlaylistRecord, PlaylistState, RemotePlaylist, RemotePlaylistMutation } from "./types.js";

export interface PlaylistSyncStatus {
  /** `error` means the last pass failed and a retry is pending. */
  readonly state: "idle" | "syncing" | "error";
  readonly error: string | null;
  readonly lastSyncedAt: string | null;
}

export interface PlaylistSyncManagerOptions {
  /** Quiet time after a local edit before it is pushed. */
  readonly debounceMs?: number;
  /** Time between full passes. `0` disables them. */
  readonly intervalMs?: number;
  /** First retry delay after a failed pass. Doubles per consecutive failure up to `maxRetryMs`. */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  /** Concurrent `getPlaylist` requests per pass. */
  readonly fetchConcurrency?: number;
}

export interface PlaylistSyncManagerService {
  readonly status: Effect.Effect<PlaylistSyncStatus>;
  /** The current status, then every change to it. */
  readonly changes: Stream.Stream<PlaylistSyncStatus>;
  /** Runs a full pass once any running pass has finished. */
  readonly sync: Effect.Effect<void, SubsonicClientError>;
}

export class PlaylistSyncManager extends Context.Service<PlaylistSyncManager, PlaylistSyncManagerService>()("@muswag/shared/PlaylistSyncManager") {}

type PlaylistApi = Pick<SubsonicApiService, "username" | "getPlaylists" | "getPlaylist" | "createPlaylist" | "updatePlaylist" | "deletePlaylist">;

/**
 * Most servers (Navidrome included) never send `readonly`, so ownership is what actually decides
 * whether we may edit a playlist. A playlist with no owner is treated as ours.
 */
function isReadonlyFor(playlist: PlaylistWithSongs, username: string): boolean {
  if (playlist.readonly === true) return true;
  return playlist.owner !== undefined && playlist.owner.toLowerCase() !== username.toLowerCase();
}

function toRemotePlaylist(playlist: PlaylistWithSongs, username: string): RemotePlaylist {
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.comment ?? "",
    public: playlist.public ?? false,
    readonly: isReadonlyFor(playlist, username),
    songIds: (playlist.entry ?? []).map(({ id }) => id),
    created: playlist.created,
    changed: playlist.changed,
    duration: playlist.duration,
    ...(playlist.owner !== undefined && { owner: playlist.owner }),
    ...(playlist.coverArt !== undefined && { coverArt: playlist.coverArt }),
    ...(playlist.allowedUser !== undefined && { allowedUser: [...playlist.allowedUser] }),
    ...(playlist.validUntil !== undefined && { validUntil: playlist.validUntil }),
  };
}

/** Rebuilds the remote view of an unchanged playlist from its last-synced snapshot, skipping a request. */
function snapshotToRemote(serverId: string, { entries, ...state }: PlaylistState): RemotePlaylist {
  return { ...state, id: serverId, songIds: songIds(entries) };
}

function songIds(entries: PlaylistState["entries"]): string[] {
  return entries.map(({ songId }) => songId);
}

function sameSongIds(left: readonly string[], right: readonly string[]): boolean {
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
    sameSongIds(left.songIds, right.songIds)
  );
}

/**
 * Snapshots of playlists that are fully in sync, keyed by server id, minus `refetch`. Anything with
 * local work pending is left out so it always gets refetched.
 */
function reusableSnapshots(records: readonly PlaylistRecord[], refetch: ReadonlySet<string>): Map<string, PlaylistState> {
  const snapshots = new Map<string, PlaylistState>();
  for (const record of records) {
    if (record.serverId === null || record.base === null) continue;
    if (refetch.has(record.serverId) || hasPendingLocalChanges(record)) continue;
    snapshots.set(record.serverId, record.base);
  }
  return snapshots;
}

/** The persisted rows, stripped of collection metadata. Waits for the collection to load from disk. */
function readLocalPlaylists(db: MuswagDb): Effect.Effect<PlaylistRecord[]> {
  return Effect.promise(() => queryOnce((query) => query.from({ playlist: db.playlists }))).pipe(
    Effect.map((rows) => rows.map(({ id, serverId, base, local, revision }) => ({ id, serverId, base, local, revision }))),
  );
}

function writeLocalPlaylists(db: MuswagDb, playlists: readonly PlaylistRecord[]): void {
  const expectedIds = new Set(playlists.map(({ id }) => id));

  for (const playlist of playlists) {
    const current = db.playlists.get(playlist.id);
    if (!current) {
      db.playlists.insert(playlist);
      continue;
    }
    const { id, serverId, base, local, revision } = current;
    if (JSON.stringify({ id, serverId, base, local, revision }) === JSON.stringify(playlist)) continue;

    db.playlists.update(playlist.id, (draft) => {
      draft.serverId = playlist.serverId;
      draft.base = playlist.base;
      draft.local = playlist.local;
      draft.revision = playlist.revision;
    });
  }

  for (const id of db.playlists.keys()) {
    if (!expectedIds.has(id)) db.playlists.delete(id);
  }
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}

const make = ({ debounceMs = 500, intervalMs = 5 * 60_000, retryMs = 5_000, maxRetryMs = 5 * 60_000, fetchConcurrency = 5 }: PlaylistSyncManagerOptions) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const api: PlaylistApi = yield* SubsonicAPI;
    const scope = yield* Effect.scope;
    const status = yield* SubscriptionRef.make<PlaylistSyncStatus>({ state: "idle", error: null, lastSyncedAt: null });
    const setStatus = (patch: Partial<PlaylistSyncStatus>) => SubscriptionRef.update(status, (current) => ({ ...current, ...patch }));
    const passLock = yield* Semaphore.make(1);
    // Holds the single pending timer, so scheduling a pass replaces (debounces) the previous one.
    const timer = yield* FiberHandle.make();
    const runTimer = yield* FiberHandle.runtime(timer)<never>();
    let retryDelay = retryMs;
    let writingFromSync = false;

    // Sync's own writes must not look like user edits, or every pass would schedule another one.
    const writeFromSync = (write: () => void) => {
      writingFromSync = true;
      try {
        write();
      } finally {
        writingFromSync = false;
      }
    };

    /**
     * `refetch: "all"` is used for full passes (startup, interval, manual sync), which self-heals
     * anything the `changed` timestamp missed: it has second granularity, so two edits inside one
     * second can look equal.
     */
    const fetchRemote = (refetch: "all" | ReadonlySet<string>) =>
      Effect.gen(function* () {
        const reusable = refetch === "all" ? new Map<string, PlaylistState>() : reusableSnapshots(yield* readLocalPlaylists(db), refetch);
        const summaries = (yield* api.getPlaylists).playlists.playlist ?? [];

        return yield* Effect.forEach(
          summaries,
          (summary) => {
            const snapshot = reusable.get(summary.id);
            if (snapshot && snapshot.changed === summary.changed && snapshot.entries.length === summary.songCount) {
              return Effect.succeed(snapshotToRemote(summary.id, snapshot));
            }
            return api.getPlaylist({ id: summary.id }).pipe(Effect.map(({ playlist }) => toRemotePlaylist(playlist, api.username)));
          },
          { concurrency: Math.max(1, fetchConcurrency) },
        );
      });

    /** Pulls remote state, merges it into the collection, and returns what still has to be pushed. */
    const reconcile = (refetch: "all" | ReadonlySet<string>) =>
      Effect.gen(function* () {
        const remote = yield* fetchRemote(refetch);
        // Local state is read after the fetch so edits made while it was in flight are merged too.
        const merged = mergePlaylists(yield* readLocalPlaylists(db), remote);
        writeFromSync(() => writeLocalPlaylists(db, merged.local));
        return merged.remote;
      });

    /**
     * Records the state we just pushed as the new `base`, because the server now holds it.
     *
     * Without this the pushed entries stay absent from `base`, so on the verification pass
     * `reconcileRemoteEntries` cannot match them and mints fresh `remote:` ids. The merge then sees the
     * local entry and the server's echo of that same entry as two independent additions and keeps both,
     * re-pushing a longer playlist every pass. If the push did not land exactly, the verification fetch
     * re-merges against the real remote state and corrects this.
     */
    const commitBase = (localId: string, state: PlaylistState) =>
      writeFromSync(() => {
        if (db.playlists.get(localId)) {
          db.playlists.update(localId, (draft) => {
            draft.base = state;
          });
        }
      });

    /** Applies one mutation. Returns the server id it touched, or `"stale"` if the remote moved first. */
    const push = (mutation: RemotePlaylistMutation) =>
      Effect.gen(function* () {
        switch (mutation.type) {
          case "create": {
            const { state } = mutation;
            const { playlist } = yield* api.createPlaylist({ name: state.name, songId: songIds(state.entries) });
            // Attach the id before anything else can fail, or a retry would create a duplicate. A
            // playlist deleted meanwhile keeps its tombstone, so the next pass deletes it remotely.
            writeFromSync(() => {
              if (db.playlists.get(mutation.localId)?.serverId === null) {
                db.playlists.update(mutation.localId, (draft) => {
                  draft.serverId = playlist.id;
                });
              }
            });
            yield* api.updatePlaylist({ playlistId: playlist.id, name: state.name, comment: state.comment, public: state.public });
            commitBase(mutation.localId, state);
            return playlist.id;
          }

          case "replace": {
            const { serverId, expected, state } = mutation;
            const nextSongIds = songIds(state.entries);
            const entriesChanged = !sameSongIds(nextSongIds, expected.songIds);

            // Subsonic has no conditional update. Re-reading right before a destructive replacement
            // narrows the race and, crucially, avoids removing indices from an older version.
            if (entriesChanged) {
              const latest = toRemotePlaylist((yield* api.getPlaylist({ id: serverId })).playlist, api.username);
              if (!sameRemoteVersion(latest, expected)) return "stale" as const;
            }

            const previousCount = expected.songIds.length;
            yield* api.updatePlaylist({
              playlistId: serverId,
              name: state.name,
              comment: state.comment,
              public: state.public,
              ...(entriesChanged && {
                songIndexToRemove: Array.from({ length: previousCount }, (_, index) => previousCount - index - 1),
                songIdToAdd: nextSongIds,
              }),
            });
            commitBase(mutation.localId, state);
            return serverId;
          }

          case "delete":
            yield* api.deletePlaylist({ id: mutation.serverId });
            return mutation.serverId;
        }
      });

    /** Returns whether another pass is needed to converge. */
    const pass = (full: boolean) =>
      Effect.gen(function* () {
        const mutations = yield* reconcile(full ? "all" : new Set());
        if (mutations.length === 0) return false;

        const pushed = yield* Effect.forEach(mutations, push);
        // Never verify a write from `base`: servers may normalize or reject parts of an update while
        // still returning success, and a stale mutation needs the actual latest remote state.
        const remaining = yield* reconcile(new Set(pushed.filter((result) => result !== "stale")));
        return remaining.length > 0 || pushed.includes("stale");
      });

    /**
     * Replaces the pending timer. The pass itself is forked detached, so replacing a timer that has
     * already fired cannot interrupt it. Its failure is already in `status`.
     */
    const schedule = (delayMs: number, full: boolean) => {
      runTimer(Effect.sleep(delayMs).pipe(Effect.andThen(Effect.forkIn(Effect.ignore(runPass(full)), scope))));
    };

    const runPass = (full: boolean): Effect.Effect<void, SubsonicClientError> =>
      Effect.gen(function* () {
        yield* setStatus({ state: "syncing", error: null });
        const exit = yield* Effect.exit(pass(full));

        if (Exit.isSuccess(exit)) {
          retryDelay = retryMs;
          yield* setStatus({ state: "idle", error: null, lastSyncedAt: new Date().toISOString() });
          if (exit.value) schedule(0, false);
        } else {
          yield* setStatus({ state: "error", error: errorMessage(exit.cause) });
          schedule(retryDelay, true);
          retryDelay = Math.min(retryDelay * 2, maxRetryMs);
        }
        return yield* exit;
      }).pipe(Semaphore.withPermits(passLock, 1));

    yield* Effect.acquireRelease(
      Effect.sync(() =>
        db.playlists.subscribeChanges(
          () => {
            if (!writingFromSync && [...db.playlists.values()].some(hasPendingLocalChanges)) {
              schedule(debounceMs, false);
            }
          },
          { includeInitialState: false },
        ),
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe()),
    );

    if (intervalMs > 0) {
      yield* Effect.sleep(intervalMs).pipe(
        Effect.map(() => schedule(0, true)),
        Effect.forever,
        Effect.forkIn(scope),
      );
    }

    schedule(0, true);

    return {
      status: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
      // Runs inside the manager's scope so closing the session aborts it.
      sync: FiberHandle.clear(timer).pipe(
        Effect.andThen(Effect.forkIn(runPass(true), scope)),
        Effect.flatMap(Fiber.join),
      ),
    } satisfies PlaylistSyncManagerService;
  });

export const PlaylistSyncManagerLive = (options: PlaylistSyncManagerOptions = {}) => Layer.effect(PlaylistSyncManager, make(options));
