import { db } from "#/lib/db-renderer";
import { PlaylistSync } from "#/lib/playlist-sync";
import {
  addPlaylistEntries,
  createPlaylist,
  deletePlaylist,
  removePlaylistEntry,
  renamePlaylist,
  setPlaylistComment,
  setPlaylistVisibility,
  type CreatePlaylistInput,
  type PlaylistRecord,
} from "@muswag/shared";

/**
 * The shared controls are synchronous and throw. Wrapping them in async functions turns those
 * throws into rejections so components can drive them with `useMutation` like the rest of the app.
 * Every edit is local-first — the sync manager picks the change up from the collection.
 */
export const PlaylistActions = {
  async create(input: CreatePlaylistInput): Promise<PlaylistRecord> {
    return createPlaylist(db, input);
  },

  async rename(playlistId: string, name: string): Promise<PlaylistRecord> {
    return renamePlaylist(db, playlistId, name);
  },

  async setComment(playlistId: string, comment: string): Promise<PlaylistRecord> {
    return setPlaylistComment(db, playlistId, comment);
  },

  async setVisibility(playlistId: string, isPublic: boolean): Promise<PlaylistRecord> {
    return setPlaylistVisibility(db, playlistId, isPublic);
  },

  async addSongs(playlistId: string, songIds: readonly string[], beforeEntryId: string | null = null) {
    return addPlaylistEntries(db, playlistId, songIds, beforeEntryId);
  },

  /** Creates a playlist and seeds it in one revision, so the sync manager pushes a single create. */
  async createWithSongs(name: string, songIds: readonly string[]): Promise<PlaylistRecord> {
    return createPlaylist(db, { name, songIds: [...songIds] });
  },

  async removeEntry(playlistId: string, entryId: string): Promise<PlaylistRecord> {
    return removePlaylistEntry(db, playlistId, entryId);
  },

  async remove(playlistId: string): Promise<void> {
    deletePlaylist(db, playlistId);
  },

  syncNow() {
    return PlaylistSync.sync();
  },
};
