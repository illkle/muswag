import type { MuswagDb } from "../db/database.js";
import type { PlaylistEntry, PlaylistRecord, PlaylistState } from "./types.js";

export interface CreatePlaylistInput {
  name: string;
  comment?: string;
  public?: boolean;
  songIds?: string[];
}

function createId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getWritablePlaylist(db: MuswagDb, playlistId: string): PlaylistRecord & { local: PlaylistState } {
  const playlist = db.playlists.get(playlistId);
  if (!playlist?.local) {
    throw new Error(`Playlist not found: ${playlistId}`);
  }
  if (playlist.local.readonly) {
    throw new Error(`Playlist is read-only: ${playlistId}`);
  }
  return playlist as PlaylistRecord & { local: PlaylistState };
}

function updatePlaylist(db: MuswagDb, playlistId: string, update: (state: PlaylistState, revision: number) => void): PlaylistRecord {
  const playlist = getWritablePlaylist(db, playlistId);
  const revision = playlist.revision + 1;

  db.playlists.update(playlistId, (draft) => {
    if (!draft.local) return;
    update(draft.local, revision);
    draft.revision = revision;
  });

  return db.playlists.get(playlistId)!;
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Playlist name cannot be empty");
  }
  return trimmed;
}

export function createPlaylist(db: MuswagDb, input: CreatePlaylistInput): PlaylistRecord {
  const id = createId();
  const entries = (input.songIds ?? []).map(
    (songId, index): PlaylistEntry => ({
      id: `local:${id}:0:${index}`,
      songId,
    }),
  );
  const local: PlaylistState = {
    name: requireName(input.name),
    comment: input.comment ?? "",
    public: input.public ?? false,
    readonly: false,
    entries,
  };
  const playlist: PlaylistRecord = {
    id,
    serverId: null,
    base: null,
    local,
    revision: 0,
  };

  db.playlists.insert(playlist);
  return playlist;
}

export function renamePlaylist(db: MuswagDb, playlistId: string, name: string): PlaylistRecord {
  return updatePlaylist(db, playlistId, (state) => {
    state.name = requireName(name);
  });
}

export function setPlaylistComment(db: MuswagDb, playlistId: string, comment: string): PlaylistRecord {
  return updatePlaylist(db, playlistId, (state) => {
    state.comment = comment;
  });
}

export function setPlaylistVisibility(db: MuswagDb, playlistId: string, isPublic: boolean): PlaylistRecord {
  return updatePlaylist(db, playlistId, (state) => {
    state.public = isPublic;
  });
}

export function addPlaylistEntry(db: MuswagDb, playlistId: string, songId: string, beforeEntryId: string | null = null): PlaylistEntry {
  let entry: PlaylistEntry | undefined;
  updatePlaylist(db, playlistId, (state, revision) => {
    entry = { id: `local:${playlistId}:${revision}`, songId };
    const index = beforeEntryId === null ? state.entries.length : state.entries.findIndex(({ id }) => id === beforeEntryId);
    if (index < 0) {
      throw new Error(`Playlist entry not found: ${beforeEntryId}`);
    }
    state.entries.splice(index, 0, entry);
  });
  return entry!;
}

export function removePlaylistEntry(db: MuswagDb, playlistId: string, entryId: string): PlaylistRecord {
  return updatePlaylist(db, playlistId, (state) => {
    const index = state.entries.findIndex(({ id }) => id === entryId);
    if (index < 0) {
      throw new Error(`Playlist entry not found: ${entryId}`);
    }
    state.entries.splice(index, 1);
  });
}

export function movePlaylistEntry(db: MuswagDb, playlistId: string, entryId: string, beforeEntryId: string | null): PlaylistRecord {
  if (entryId === beforeEntryId) {
    return getWritablePlaylist(db, playlistId);
  }

  return updatePlaylist(db, playlistId, (state) => {
    const sourceIndex = state.entries.findIndex(({ id }) => id === entryId);
    if (sourceIndex < 0) {
      throw new Error(`Playlist entry not found: ${entryId}`);
    }
    const [entry] = state.entries.splice(sourceIndex, 1);
    const targetIndex = beforeEntryId === null ? state.entries.length : state.entries.findIndex(({ id }) => id === beforeEntryId);
    if (targetIndex < 0) {
      throw new Error(`Playlist entry not found: ${beforeEntryId}`);
    }
    state.entries.splice(targetIndex, 0, entry!);
  });
}

export function deletePlaylist(db: MuswagDb, playlistId: string): void {
  const playlist = getWritablePlaylist(db, playlistId);
  if (playlist.base === null && playlist.serverId === null) {
    db.playlists.delete(playlistId);
    return;
  }

  db.playlists.update(playlistId, (draft) => {
    draft.local = null;
    draft.revision += 1;
  });
}
