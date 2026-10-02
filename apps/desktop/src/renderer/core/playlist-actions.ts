import { db } from "#/lib/db-renderer";
import { appCommand } from "#/lib/app-ipc";
import type { Written } from "#shared/commands/app";
import type { CreatePlaylistInput, PlaylistEntry, PlaylistRecord } from "@muswag/model";

/**
 * Playlist edits run in main, which saves them locally and syncs them to the server. Each resolves
 * once the change has reached the playlists collection, so the UI can read it right away.
 */
const synced = async <T>(write: Promise<Written<T>>): Promise<T> => {
  const { value, position } = await write;
  await db.playlists.utils.awaitPosition(position);
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

  moveEntry: (playlistId: string, entryId: string, beforeEntryId: string | null): Promise<void> => synced(appCommand("playlists:moveEntry", playlistId, entryId, beforeEntryId)),

  remove: (playlistId: string): Promise<void> => synced(appCommand("playlists:delete", playlistId)),

  syncNow: () => appCommand("playlists:sync"),
};
