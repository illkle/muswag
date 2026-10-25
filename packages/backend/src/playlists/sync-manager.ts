import {
  IDLE_PLAYLIST_SYNC,
  playlists,
  type PlaylistRecord,
  type PlaylistState,
  type PlaylistSyncStatus,
  type PlaylistWithSongs,
  type RemotePlaylist,
  type RemotePlaylistMutation,
  songs,
  type SubsonicApiError,
  type SubsonicDecodeError,
  type SubsonicHttpError,
  type UpdatePlaylistArgs,
} from "@muswag/model";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Stream, SubscriptionRef } from "effect";

import { SubsonicAPI, type SubsonicApiService, type SubsonicClientError } from "../api/subsonic-api.js";
import { Db, type Database, write } from "../db/database.js";
import { chunks, STATEMENT_IDS } from "../db/upsert.js";
import { PlaylistEdits } from "./commands.js";
import { hasPendingLocalChanges, mergePlaylists, sameArray } from "./merge.js";

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60_000;
const DEFAULT_FETCH_CONCURRENCY = 5;
/** Subsonic's code for a playlist or song that is not there. */
const NOT_FOUND = 70;
/**
 * Subsonic's codes for a request the server will not take however often it is sent: a parameter is
 * missing, the user may not do this, the playlist or a song is not there. Its other codes say the
 * server failed or the session is not accepted, which the next pass may find changed.
 */
const REFUSAL_CODES: ReadonlyArray<number | undefined> = [10, 50, NOT_FOUND];

type PlaylistApi = Pick<SubsonicApiService, "getPlaylists" | "getPlaylist" | "createPlaylist" | "updatePlaylist" | "deletePlaylist">;
/** A pass to run after `delayMs`, and the `sync` callers waiting for its outcome. */
type SyncRequest = { readonly full: boolean; readonly delayMs: number; readonly waiters: ReadonlyArray<Deferred.Deferred<PlaylistSyncStatus>> };

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
  readonly status: Effect.Effect<PlaylistSyncStatus>;
  readonly changes: Stream.Stream<PlaylistSyncStatus>;
  /** Queues a full pass. Failures are reflected in the returned status. */
  readonly sync: Effect.Effect<PlaylistSyncStatus>;
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
 * `reusable` is empty for full passes (startup, manual sync, retry), which self-heals anything the
 * `changed` timestamp missed — it has second granularity, so two edits inside one second can look equal.
 *
 * A playlist the server does not answer for is taken to be as it was last synced, so that the others
 * are still merged and pushed: left out, it would read as deleted on the server. `lastSynced` has
 * that state of every playlist here with a server id, or `null` where it has none, and then there is
 * nothing to stand in for it and the pass fails as a whole. The errors come back for the pass to fail
 * with once it has pushed the rest, and the server ids of the playlists stood in for, which the pass
 * pushes nothing to.
 */
function fetchRemotePlaylists(api: PlaylistApi, currentUsername: string, concurrency: number, reusable: ReadonlyMap<string, PlaylistState>, lastSynced: ReadonlyMap<string, PlaylistState | null>) {
  return Effect.gen(function* () {
    const summaries = (yield* api.getPlaylists).playlists.playlist ?? [];
    const failures: SubsonicClientError[] = [];
    const unread = new Set<string>();

    const remote = yield* Effect.forEach(
      summaries,
      (summary) => {
        const base = reusable.get(summary.id);
        if (base && matchesSummary(base, summary)) {
          return Effect.succeed(baseToRemotePlaylist(summary.id, base));
        }
        return api.getPlaylist({ id: summary.id }).pipe(
          Effect.map(({ playlist }): RemotePlaylist | null => toRemotePlaylist(playlist, currentUsername)),
          Effect.catch((error) => {
            const synced = lastSynced.get(summary.id);
            if (synced === null) return Effect.fail(error);
            failures.push(error);
            // One nobody here has seen is picked up by the pass after.
            if (synced === undefined) return Effect.succeed(null);
            unread.add(summary.id);
            return Effect.succeed(baseToRemotePlaylist(summary.id, synced));
          }),
        );
      },
      { concurrency: Math.max(1, concurrency) },
    );
    return { remote: remote.filter((playlist) => playlist !== null), failures, unread };
  });
}

/** What each playlist with a server id was when it was last synced, `null` for one that has not been. */
function lastSyncedStates(records: readonly PlaylistRecord[]): Map<string, PlaylistState | null> {
  return new Map(records.flatMap((record) => (record.serverId === null ? [] : [[record.serverId, record.base] as const])));
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

function sameRemoteVersion(left: RemotePlaylist, right: RemotePlaylist): boolean {
  return (
    left.name === right.name &&
    left.comment === right.comment &&
    left.public === right.public &&
    left.readonly === right.readonly &&
    left.owner === right.owner &&
    left.changed === right.changed &&
    sameArray(left.songIds, right.songIds)
  );
}

/**
 * The indices of `previous` to remove to get `next`, highest first so that each removal leaves the
 * indices after it in place. Answers `null` when `next` is not `previous` with some songs left out.
 * Songs are matched from the start, so of a song that appears twice in a row the later copy is the one
 * removed.
 */
function removedSongIndices(previous: readonly string[], next: readonly string[]): number[] | null {
  if (next.length > previous.length) return null;
  const removed: number[] = [];
  let kept = 0;
  previous.forEach((songId, index) => {
    if (kept < next.length && songId === next[kept]) kept += 1;
    else removed.push(index);
  });
  return kept === next.length ? removed.reverse() : null;
}

/**
 * The entry changes that turn the server's `previous` songs into `next`. Subsonic removes songs by
 * their index in the list it has and appends added songs at the end, so a list that only grew at the
 * end or only lost songs is sent as just that. Anything else, such as a reorder, removes every song and
 * adds the whole new list back.
 */
function songListUpdate(previous: readonly string[], next: readonly string[]): Pick<UpdatePlaylistArgs, "songIdToAdd" | "songIndexToRemove"> {
  if (next.length > previous.length && sameArray(previous, next.slice(0, previous.length))) {
    return { songIdToAdd: next.slice(previous.length) };
  }
  const removed = removedSongIndices(previous, next);
  if (removed) return { songIndexToRemove: removed };
  return {
    songIndexToRemove: Array.from({ length: previous.length }, (_, index) => previous.length - index - 1),
    songIdToAdd: [...next],
  };
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
        const entriesChanged = !sameArray(nextSongIds, mutation.expected.songIds);
        let previousSongIds = mutation.expected.songIds;

        // Subsonic has no conditional update operation. Re-reading immediately before a destructive
        // replacement narrows the race and, crucially, avoids applying indices from an older version.
        if (entriesChanged) {
          const latest = toRemotePlaylist((yield* api.getPlaylist({ id: mutation.serverId })).playlist, currentUsername);
          if (!sameRemoteVersion(latest, mutation.expected)) return "stale" as const;
          previousSongIds = latest.songIds;
        }

        yield* api.updatePlaylist({
          playlistId: mutation.serverId,
          name: mutation.state.name,
          comment: mutation.state.comment,
          public: mutation.state.public,
          ...(entriesChanged && songListUpdate(previousSongIds, nextSongIds)),
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

/**
 * Gives up on the change behind a mutation the server refused, so it is not pushed again: the playlist
 * goes back to what the server last had, and one the server never had is removed. Answers with what
 * to tell the user, or `null` when nothing was given up.
 */
function discardLocalChange(db: Database, mutation: RemotePlaylistMutation, error: SubsonicApiError) {
  return write(
    Effect.gen(function* () {
      const [record] = yield* db.select().from(playlists).where(eq(playlists.id, mutation.localId));
      // Edited again while the server was asked: what it refused is no longer what the playlist
      // holds, and the next pass asks about that.
      const pushed = mutation.type === "delete" ? null : mutation.state;
      if (!record || JSON.stringify(record.local) !== JSON.stringify(pushed)) return null;
      if (record.base) yield* db.update(playlists).set({ local: record.base }).where(eq(playlists.id, mutation.localId));
      else if (record.serverId === null) yield* db.delete(playlists).where(eq(playlists.id, mutation.localId));
      // The server made the playlist and refused what was sent after: it has it, so it stays, and the
      // next pass takes what the server holds as its base.
      else return null;

      const name = (mutation.type === "delete" ? record?.base?.name : mutation.state.name) ?? "";
      switch (mutation.type) {
        case "create":
          return `The server refused the new playlist "${name}", which was removed (${error.message})`;
        case "replace":
          return `The server refused the changes to the playlist "${name}", which were undone (${error.message})`;
        case "delete":
          return `The server refused to delete the playlist "${name}" (${error.message})`;
      }
    }),
  );
}

/**
 * The mutation with the songs it adds that the library no longer has left out, or `null` when it adds
 * none. A server answers "not found" to a playlist with such a song, which was most likely deleted on
 * the server after it was added here; sent again without it, the rest of the change goes through.
 * Songs the server already had in the playlist stay: the library may not have caught up with them yet.
 */
function dropMissingSongs(db: Database, mutation: Exclude<RemotePlaylistMutation, { type: "delete" }>) {
  return write(
    Effect.gen(function* () {
      const [record] = yield* db.select().from(playlists).where(eq(playlists.id, mutation.localId));
      // Edited again meanwhile: the next pass sends that.
      if (!record?.local || JSON.stringify(record.local) !== JSON.stringify(mutation.state)) return null;
      // The server made the playlist and the request after named no songs; sent again, the create
      // would make a second one.
      if (mutation.type === "create" && record.serverId !== null) return null;
      const synced = new Set(record.base?.entries.map(({ id }) => id));
      const added = [...new Set(mutation.state.entries.filter(({ id }) => !synced.has(id)).map(({ songId }) => songId))];
      const known = new Set<string>();
      for (const ids of chunks(added, STATEMENT_IDS)) {
        for (const { id } of yield* db
          .select({ id: songs.id })
          .from(songs)
          .where(inArray(songs.id, [...ids])))
          known.add(id);
      }
      const entries = mutation.state.entries.filter(({ id, songId }) => synced.has(id) || known.has(songId));
      if (entries.length === mutation.state.entries.length) return null;
      const state = { ...mutation.state, entries };
      yield* db.update(playlists).set({ local: state }).where(eq(playlists.id, mutation.localId));
      return { ...mutation, state };
    }),
  );
}

/** One pass for both requests: full if either asked for that, after the wait the later one asked for. */
const joinRequests = (earlier: SyncRequest, later: SyncRequest): SyncRequest => ({
  full: earlier.full || later.full,
  delayMs: later.delayMs,
  waiters: [...earlier.waiters, ...later.waiters],
});

const makePlaylistSyncManager = (options: PlaylistSyncManagerOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const api = yield* SubsonicAPI;
    const edits = yield* PlaylistEdits;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    const fetchConcurrency = options.fetchConcurrency ?? DEFAULT_FETCH_CONCURRENCY;
    const requests = yield* Queue.unbounded<SyncRequest>();
    const status = yield* SubscriptionRef.make<PlaylistSyncStatus>(IDLE_PLAYLIST_SYNC);
    let retryDelay = retryMs;
    /** Passes in a row that each asked for another. */
    let reruns = 0;

    const request = (full: boolean, delayMs: number) => Queue.offer(requests, { full, delayMs, waiters: [] }).pipe(Effect.asVoid);

    const runPass = (full: boolean) =>
      Effect.gen(function* () {
        let needsRerun = false;

        /** The first playlist the server did not answer for, which fails the pass once the rest are pushed. */
        let unread: SubsonicClientError | undefined;
        /** The server ids of the playlists stood in for by what they were last synced as. */
        const unreadIds = new Set<string>();

        const fetchPlaylists = (forceIds: ReadonlySet<string> = new Set()) =>
          Effect.gen(function* () {
            const records = yield* readLocalPlaylists(db);
            // Records with pending local work are never reused, so a mutated playlist is always verified.
            const reusable = full ? new Map<string, PlaylistState>() : reusableBases(records);
            for (const serverId of forceIds) reusable.delete(serverId);
            const fetched = yield* fetchRemotePlaylists(api, api.username, fetchConcurrency, reusable, lastSyncedStates(records));
            for (const error of fetched.failures) yield* Effect.logWarning(`A playlist could not be read from the server, so it is synced as it was last time (${error.message})`);
            unread ??= fetched.failures[0];
            for (const serverId of fetched.unread) unreadIds.add(serverId);
            const { remote } = fetched;
            return remote;
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
        const refused: string[] = [];
        let failure: SubsonicApiError | SubsonicDecodeError | SubsonicHttpError | undefined;
        for (let mutation of merged.remote) {
          // What a playlist the server did not answer for is pushed against is only what it was last synced
          // as, and a change of its name would go out unchecked. It waits for a pass that reads it.
          if (mutation.type !== "create" && unreadIds.has(mutation.serverId)) continue;
          // The server answered, so the playlists after this one are still pushed. No answer at all
          // fails the pass here: the next request would fare no better.
          const push = (pushed: RemotePlaylistMutation) =>
            executeRemoteMutation(db, api, pushed, api.username).pipe(Effect.catchTag(["SubsonicApiError", "SubsonicDecodeError", "SubsonicHttpError"], (error) => Effect.succeed(error)));
          let result = yield* push(mutation);
          if (typeof result !== "string" && result._tag === "SubsonicApiError" && result.code === NOT_FOUND) {
            // Deleting a playlist the server no longer has is done.
            if (mutation.type === "delete") result = "applied";
            else {
              const without = yield* dropMissingSongs(db, mutation);
              if (without) {
                yield* Effect.logWarning(`Songs the library no longer has were left out of the playlist "${without.state.name}" (${result.message})`);
                mutation = without;
                result = yield* push(mutation);
              }
            }
          }
          if (result === "stale") needsRerun = true;
          else if (result !== "applied") {
            if (result._tag === "SubsonicApiError" && REFUSAL_CODES.includes(result.code)) {
              const message = yield* discardLocalChange(db, mutation, result);
              if (message !== null) refused.push(message);
              yield* Effect.logWarning(message ?? `The server refused a change to a playlist (${result.message})`);
            } else failure ??= result;
          }
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

        // A change the server failed on stays pending, and the pass is retried as a failed one is, as
        // it is when a playlist could not be read.
        const failed = failure ?? unread;
        if (failed) return yield* failed;
        return { needsRerun, refused };
      });

    // With nothing asked for, the interval starts a pass that picks up what changed on the server.
    const nextRequest =
      intervalMs > 0 ? Queue.take(requests).pipe(Effect.timeoutOption(intervalMs), Effect.map(Option.getOrElse((): SyncRequest => ({ full: false, delayMs: 0, waiters: [] })))) : Queue.take(requests);

    const cycle = Effect.gen(function* () {
      let next = yield* nextRequest;
      // A request that arrives during the wait joins the pass and restarts the wait with its own delay,
      // which debounces edits and lets a manual sync run at once.
      if (next.delayMs > 0) yield* SubscriptionRef.update(status, (previous) => ({ ...previous, state: "scheduled" as const }));
      while (next.delayMs > 0) {
        const more = yield* Queue.take(requests).pipe(Effect.timeoutOption(next.delayMs));
        if (Option.isNone(more)) break;
        next = joinRequests(next, more.value);
      }
      for (const more of yield* Queue.clear(requests)) next = joinRequests(next, more);

      yield* SubscriptionRef.update(status, (previous) => ({ ...previous, state: "syncing" as const, error: null }));
      const exit = yield* Effect.exit(runPass(next.full));
      if (Exit.isSuccess(exit)) {
        const { needsRerun, refused } = exit.value;
        yield* SubscriptionRef.set(status, { state: "idle", error: refused.length > 0 ? refused.join(" ") : null, lastSyncedAt: new Date().toISOString() });
        if (!needsRerun) {
          reruns = 0;
          retryDelay = retryMs;
        } else {
          // One more pass at once settles a change that crossed with one on the server. A pass that
          // keeps asking for another is slowed down as a failing one is, so it cannot hammer the server.
          yield* request(false, reruns === 0 ? 0 : retryDelay);
          if (reruns > 0) retryDelay = Math.min(retryDelay * 2, maxRetryMs);
          reruns += 1;
        }
      } else {
        const error = Cause.squash(exit.cause);
        yield* SubscriptionRef.update(status, (previous) => ({ ...previous, state: "error" as const, error: error instanceof Error ? error.message : String(error) }));
        yield* request(true, retryDelay);
        retryDelay = Math.min(retryDelay * 2, maxRetryMs);
      }

      // Read before the follow-up changes the public state: callers need the result of this pass.
      const result = yield* SubscriptionRef.get(status);
      for (const waiter of next.waiters) yield* Deferred.succeed(waiter, result);
    });

    // Startup pulls everything once.
    yield* request(true, 0);
    // Passes belong to the session: closing it, e.g. on logout, interrupts the one running.
    const loop = yield* Effect.forkScoped(Effect.forever(cycle));

    // Local edits come from the playlist commands; sync's own writes are not announced.
    yield* Effect.forkScoped(Stream.runForEach(edits.stream, () => request(false, debounceMs)));

    return {
      status: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
      sync: Effect.gen(function* () {
        const result = yield* Deferred.make<PlaylistSyncStatus>();
        yield* Queue.offer(requests, { full: true, delayMs: 0, waiters: [result] });
        // A pass cut short by the session closing reports nothing, so its callers get the last status.
        const closed = Fiber.await(loop).pipe(
          Effect.andThen(SubscriptionRef.get(status)),
          Effect.map((last): PlaylistSyncStatus => ({ ...last, state: "idle" })),
        );
        return yield* Effect.raceFirst(Deferred.await(result), closed);
      }),
    } satisfies PlaylistSyncManagerService;
  });
