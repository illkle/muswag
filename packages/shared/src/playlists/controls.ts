import { Data, Effect } from "effect";

import { MuswagDatabase } from "../db/database.js";
import type { PlaylistDetails, PlaylistEntry, PlaylistRecord, PlaylistState } from "./types.js";

/**
 * Local-first playlist edits. Each one writes a new revision to `db.playlists` and nothing else;
 * the sync manager notices the change and pushes it.
 */

export class PlaylistNotFound extends Data.TaggedError("PlaylistNotFound")<{ readonly playlistId: string }> {
  override get message() {
    return `Playlist not found: ${this.playlistId}`;
  }
}

export class PlaylistReadOnly extends Data.TaggedError("PlaylistReadOnly")<{ readonly playlistId: string }> {
  override get message() {
    return `Playlist is read-only: ${this.playlistId}`;
  }
}

export class PlaylistEntryNotFound extends Data.TaggedError("PlaylistEntryNotFound")<{ readonly entryId: string }> {
  override get message() {
    return `Playlist entry not found: ${this.entryId}`;
  }
}

export class EmptyPlaylistName extends Data.TaggedError("EmptyPlaylistName") {
  override get message() {
    return "Playlist name cannot be empty";
  }
}

export type PlaylistEditError = PlaylistNotFound | PlaylistReadOnly | PlaylistEntryNotFound | EmptyPlaylistName;

export interface CreatePlaylistInput extends Partial<PlaylistDetails> {
  name: string;
  songIds?: readonly string[];
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Entry ids carry the index because every entry added in one revision shares that revision. */
function newEntries(playlistId: string, revision: number, songIds: readonly string[]): PlaylistEntry[] {
  return songIds.map((songId, index) => ({ id: `local:${playlistId}:${revision}:${index}`, songId }));
}

function validName(name: string): Effect.Effect<string, EmptyPlaylistName> {
  const trimmed = name.trim();
  return trimmed ? Effect.succeed(trimmed) : Effect.fail(new EmptyPlaylistName());
}

function entryIndex(entries: readonly PlaylistEntry[], entryId: string): Effect.Effect<number, PlaylistEntryNotFound> {
  const index = entries.findIndex(({ id }) => id === entryId);
  return index < 0 ? Effect.fail(new PlaylistEntryNotFound({ entryId })) : Effect.succeed(index);
}

/** Resolves the insertion point for `before`, where `null` means "append". */
function anchorIndex(entries: readonly PlaylistEntry[], before: string | null): Effect.Effect<number, PlaylistEntryNotFound> {
  return before === null ? Effect.succeed(entries.length) : entryIndex(entries, before);
}

const writable = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const playlist = db.playlists.get(playlistId);
    if (!playlist?.local) return yield* new PlaylistNotFound({ playlistId });
    if (playlist.local.readonly) return yield* new PlaylistReadOnly({ playlistId });
    return { ...playlist, local: playlist.local };
  });

/**
 * Runs `change` against a private copy of the playlist and stores the result as the next revision.
 * Synced records can share `base` and `local` objects, so editing in place would also rewrite the
 * last-synced snapshot. A failing `change` leaves the record untouched.
 */
const edit = <E>(playlistId: string, change: (state: PlaylistState, revision: number) => Effect.Effect<PlaylistState | undefined, E>) =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const playlist = yield* writable(playlistId);
    const revision = playlist.revision + 1;
    const local = yield* change(structuredClone(playlist.local), revision);
    if (!local) return playlist;

    db.playlists.update(playlistId, (draft) => {
      draft.local = local;
      draft.revision = revision;
    });
    return db.playlists.get(playlistId)!;
  });

export const createPlaylist = (input: CreatePlaylistInput): Effect.Effect<PlaylistRecord, EmptyPlaylistName, MuswagDatabase> =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    const id = createId();
    const playlist: PlaylistRecord = {
      id,
      serverId: null,
      base: null,
      local: {
        name: yield* validName(input.name),
        comment: input.comment ?? "",
        public: input.public ?? false,
        readonly: false,
        entries: newEntries(id, 0, input.songIds ?? []),
      },
      revision: 0,
    };

    db.playlists.insert(playlist);
    return playlist;
  });

/** Applies every changed field as one revision. A patch that changes nothing writes nothing. */
export const updatePlaylist = (playlistId: string, patch: Partial<PlaylistDetails>): Effect.Effect<PlaylistRecord, PlaylistEditError, MuswagDatabase> =>
  edit(playlistId, (state) =>
    Effect.gen(function* () {
      const next = {
        ...state,
        ...patch,
        name: patch.name === undefined ? state.name : yield* validName(patch.name),
      };
      const changed = next.name !== state.name || next.comment !== state.comment || next.public !== state.public;
      return changed ? next : undefined;
    }),
  );

/** Inserts every song as one revision, so adding an album costs a single write and a single sync pass. */
export const addSongsToPlaylist = (playlistId: string, songIds: readonly string[], before: string | null = null): Effect.Effect<PlaylistRecord, PlaylistEditError, MuswagDatabase> =>
  edit(playlistId, (state, revision) =>
    anchorIndex(state.entries, before).pipe(
      Effect.map((index) => {
        if (songIds.length === 0) return undefined;
        state.entries.splice(index, 0, ...newEntries(playlistId, revision, songIds));
        return state;
      }),
    ),
  );

export const removePlaylistEntry = (playlistId: string, entryId: string): Effect.Effect<PlaylistRecord, PlaylistEditError, MuswagDatabase> =>
  edit(playlistId, (state) =>
    entryIndex(state.entries, entryId).pipe(
      Effect.map((index) => {
        state.entries.splice(index, 1);
        return state;
      }),
    ),
  );

/** Moves an entry in front of `before`, where `null` moves it to the end. */
export const movePlaylistEntry = (playlistId: string, entryId: string, before: string | null): Effect.Effect<PlaylistRecord, PlaylistEditError, MuswagDatabase> =>
  edit(playlistId, (state) =>
    Effect.gen(function* () {
      if (entryId === before) return undefined;
      const [entry] = state.entries.splice(yield* entryIndex(state.entries, entryId), 1);
      state.entries.splice(yield* anchorIndex(state.entries, before), 0, entry!);
      return state;
    }),
  );

/**
 * Leaves a tombstone even for playlists that never reached the server. A create request may already
 * be in flight; keeping the row lets the sync manager attach the returned server id and delete it.
 */
export const deletePlaylist = (playlistId: string): Effect.Effect<void, PlaylistNotFound | PlaylistReadOnly, MuswagDatabase> =>
  Effect.gen(function* () {
    const db = yield* MuswagDatabase;
    yield* writable(playlistId);
    db.playlists.update(playlistId, (draft) => {
      draft.local = null;
      draft.revision += 1;
    });
  });
