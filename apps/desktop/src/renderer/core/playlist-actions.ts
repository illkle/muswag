import { AppClient } from "#/core/client";
import { runtime } from "#/core/runtime";
import { addSongsToPlaylist, createPlaylist, deletePlaylist, removePlaylistEntry, updatePlaylist, type CreatePlaylistInput, type PlaylistDetails } from "@muswag/shared";

/**
 * Promise wrappers so components can drive the shared playlist edits with `useMutation`. Every edit
 * is local-first; the sync manager picks the change up from the collection.
 */
export const PlaylistActions = {
  create: (input: CreatePlaylistInput) => runtime.runPromise(createPlaylist(input)),
  update: (playlistId: string, details: Partial<PlaylistDetails>) => runtime.runPromise(updatePlaylist(playlistId, details)),
  addSongs: (playlistId: string, songIds: readonly string[]) => runtime.runPromise(addSongsToPlaylist(playlistId, songIds)),
  removeEntry: (playlistId: string, entryId: string) => runtime.runPromise(removePlaylistEntry(playlistId, entryId)),
  remove: (playlistId: string) => runtime.runPromise(deletePlaylist(playlistId)),
  syncNow: () => AppClient.syncPlaylists(),
};
