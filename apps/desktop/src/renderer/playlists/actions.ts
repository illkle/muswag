import { appCommand } from "#/data/app-command";
import { invalidateTables } from "#/data/main-read";
import type { CreatePlaylistInput, PlaylistEntry, PlaylistRecord } from "@muswag/model";

/**
 * Playlist edits run in main, which saves them locally and syncs them to the server. Each resolves
 * once the playlists have been read again, so the UI can read the change right away.
 */
const synced = async <T>(write: Promise<T>): Promise<T> => {
  const value = await write;
  await invalidateTables(["playlists"]);
  return value;
};

export const PlaylistActions = {
  create: (input: CreatePlaylistInput): Promise<PlaylistRecord> => synced(appCommand("playlists:create", input)),

  rename: (playlistId: string, name: string): Promise<void> => synced(appCommand("playlists:rename", playlistId, name)),

  setComment: (playlistId: string, comment: string): Promise<void> => synced(appCommand("playlists:setComment", playlistId, comment)),

  setVisibility: (playlistId: string, isPublic: boolean): Promise<void> => synced(appCommand("playlists:setVisibility", playlistId, isPublic)),

  addSongs: (playlistId: string, songIds: readonly string[], beforeEntryId: string | null = null): Promise<PlaylistEntry[]> =>
    synced(appCommand("playlists:addEntries", playlistId, [...songIds], beforeEntryId)),

  removeEntry: (playlistId: string, entryId: string): Promise<void> => synced(appCommand("playlists:removeEntry", playlistId, entryId)),

  /** Moves entries, in playlist order, before the entry `beforeEntryId`, or to the end. */
  moveEntries: (playlistId: string, entryIds: readonly string[], beforeEntryId: string | null): Promise<void> => synced(appCommand("playlists:moveEntries", playlistId, [...entryIds], beforeEntryId)),

  remove: (playlistId: string): Promise<void> => synced(appCommand("playlists:delete", playlistId)),

  syncNow: () => appCommand("playlists:sync"),
};
