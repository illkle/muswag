import { playlists, type CreatePlaylistInput, type PlaylistEntry, type PlaylistRecord, type PlaylistState } from "@muswag/model";
import { eq } from "drizzle-orm";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Context, Data, Effect, Layer, PubSub, Stream } from "effect";

import { Db } from "../db/database.js";

export class PlaylistError extends Data.TaggedError("PlaylistError")<{ readonly message: string }> {}

/** Local playlist edits, so the sync manager can push them. */
export class PlaylistEdits extends Context.Service<
  PlaylistEdits,
  {
    readonly notify: Effect.Effect<void>;
    readonly stream: Stream.Stream<void>;
  }
>()("@muswag/backend/PlaylistEdits") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<void>();
      return { notify: PubSub.publish(pubsub, undefined).pipe(Effect.asVoid), stream: Stream.fromPubSub(pubsub) };
    }),
  );
}

function createId(): string {
  return globalThis.crypto.randomUUID();
}

const fail = (message: string) => new PlaylistError({ message });

/** Runs validation that throws `PlaylistError`, failing with it instead. */
const attempt = <A>(f: () => A) => Effect.try({ try: f, catch: (error) => (error instanceof PlaylistError ? error : fail(String(error))) });

type WritablePlaylist = PlaylistRecord & { local: PlaylistState };

function requireWritable(playlist: PlaylistRecord | undefined, playlistId: string): WritablePlaylist {
  if (!playlist?.local) throw fail(`Playlist not found: ${playlistId}`);
  if (playlist.local.readonly) throw fail(`Playlist is read-only: ${playlistId}`);
  return playlist as WritablePlaylist;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw fail("Playlist name cannot be empty");
  return trimmed;
}

function requireEntryIndex(entries: readonly PlaylistEntry[], entryId: string): number {
  const index = entries.findIndex(({ id }) => id === entryId);
  if (index < 0) throw fail(`Playlist entry not found: ${entryId}`);
  return index;
}

/** Resolves the insertion point for `beforeEntryId`, where `null` means "append". */
function requireAnchorIndex(entries: readonly PlaylistEntry[], beforeEntryId: string | null): number {
  return beforeEntryId === null ? entries.length : requireEntryIndex(entries, beforeEntryId);
}

/** A new revision of the playlist with `update` applied to a copy of its local state. */
function edit(playlist: WritablePlaylist, update: (state: PlaylistState) => void): PlaylistRecord {
  const local = structuredClone(playlist.local);
  update(local);
  return { ...playlist, local, revision: playlist.revision + 1 };
}

/**
 * Local-first playlist edits. Each applies to the database in one transaction, bumps the
 * playlist's revision and tells the sync manager, which pushes the change to the server.
 */
export class PlaylistCommands extends Context.Service<PlaylistCommands>()("@muswag/backend/PlaylistCommands", {
  make: Effect.gen(function* () {
    const db = yield* Db;
    const edits = yield* PlaylistEdits;
    const mirror = yield* SqliteMirror;

    const read = (playlistId: string) =>
      db
        .select()
        .from(playlists)
        .where(eq(playlists.id, playlistId))
        .pipe(Effect.map((rows) => rows[0]));

    /** Reads the playlist, computes its next version and saves it, all in one transaction. */
    const change = <A>(playlistId: string, next: (playlist: PlaylistRecord | undefined) => { readonly record: PlaylistRecord; readonly result: A } | null) =>
      mirror
        .write(
          Effect.gen(function* () {
            const current = yield* read(playlistId);
            const outcome = yield* attempt(() => next(current));
            if (!outcome) return { changed: false, result: undefined };
            const { id, ...values } = outcome.record;
            yield* db.update(playlists).set(values).where(eq(playlists.id, id));
            return { changed: true, result: outcome.result };
          }),
        )
        .pipe(
          Effect.tap(({ changed }) => (changed ? edits.notify : Effect.void)),
          Effect.map(({ result }) => result),
        );

    const update = (playlistId: string, apply: (state: PlaylistState) => void) =>
      change(playlistId, (current) => ({ record: edit(requireWritable(current, playlistId), apply), result: undefined })).pipe(Effect.asVoid);

    return {
      create: (input: CreatePlaylistInput) =>
        attempt((): PlaylistRecord => {
          const id = createId();
          return {
            id,
            serverId: null,
            base: null,
            local: {
              name: requireName(input.name),
              comment: input.comment ?? "",
              public: input.public ?? false,
              readonly: false,
              entries: (input.songIds ?? []).map((songId, index) => ({ id: `local:${id}:0:${index}`, songId })),
            },
            revision: 0,
          };
        }).pipe(Effect.tap((record) => mirror.write(db.insert(playlists).values(record)).pipe(Effect.andThen(edits.notify)))),

      rename: (playlistId: string, name: string) =>
        attempt(() => requireName(name)).pipe(
          Effect.flatMap((trimmed) =>
            update(playlistId, (state) => {
              state.name = trimmed;
            }),
          ),
        ),

      setComment: (playlistId: string, comment: string) =>
        update(playlistId, (state) => {
          state.comment = comment;
        }),

      setVisibility: (playlistId: string, isPublic: boolean) =>
        update(playlistId, (state) => {
          state.public = isPublic;
        }),

      /**
       * Inserts every song as one revision, so adding an album costs a single write and a single sync
       * pass. Entry ids carry the index because they all share the revision that makes them unique.
       */
      addEntries: (playlistId: string, songIds: readonly string[], beforeEntryId: string | null = null) =>
        change(playlistId, (current) => {
          const playlist = requireWritable(current, playlistId);
          const insertAt = requireAnchorIndex(playlist.local.entries, beforeEntryId);
          if (songIds.length === 0) return null;
          const revision = playlist.revision + 1;
          const entries = songIds.map((songId, index): PlaylistEntry => ({ id: `local:${playlistId}:${revision}:${index}`, songId }));
          const record = edit(playlist, (state) => {
            state.entries.splice(insertAt, 0, ...entries);
          });
          return { record, result: entries };
        }).pipe(Effect.map((entries) => entries ?? [])),

      removeEntry: (playlistId: string, entryId: string) =>
        change(playlistId, (current) => {
          const playlist = requireWritable(current, playlistId);
          const index = requireEntryIndex(playlist.local.entries, entryId);
          const record = edit(playlist, (state) => {
            state.entries.splice(index, 1);
          });
          return { record, result: undefined };
        }).pipe(Effect.asVoid),

      moveEntry: (playlistId: string, entryId: string, beforeEntryId: string | null) =>
        change(playlistId, (current) => {
          const playlist = requireWritable(current, playlistId);
          if (entryId === beforeEntryId) return null;
          const sourceIndex = requireEntryIndex(playlist.local.entries, entryId);
          if (beforeEntryId !== null) requireEntryIndex(playlist.local.entries, beforeEntryId);
          const record = edit(playlist, (state) => {
            const [entry] = state.entries.splice(sourceIndex, 1);
            state.entries.splice(requireAnchorIndex(state.entries, beforeEntryId), 0, entry!);
          });
          return { record, result: undefined };
        }).pipe(Effect.asVoid),

      /**
       * Keeps local-only deletes as tombstones too. A create request may already be in flight;
       * retaining the row lets the sync manager attach the returned server id and delete that remote
       * playlist.
       */
      delete: (playlistId: string) =>
        change(playlistId, (current) => {
          const playlist = requireWritable(current, playlistId);
          return { record: { ...playlist, local: null, revision: playlist.revision + 1 }, result: undefined };
        }).pipe(Effect.asVoid),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
