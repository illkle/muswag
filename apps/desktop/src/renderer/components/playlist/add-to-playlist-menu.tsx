import { PlaylistActions } from "#/playlists/actions";
import { usePlaylists } from "#/playlists/queries";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon } from "@phosphor-icons/react";

import { openNewPlaylistDialog } from "#/components/playlist/new-playlist-dialog";
import { ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "#/components/ui/context-menu";

export function AddToPlaylistMenu({ songIds }: { songIds: readonly string[] }) {
  const { playlists } = usePlaylists();

  const addMutation = useMutation({
    mutationFn: (playlistId: string) => PlaylistActions.addSongs(playlistId, songIds),
  });

  const writable = playlists.filter(({ readonly }) => !readonly);
  const nothingToAdd = songIds.length === 0;

  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>
          Add {songIds.length} {songIds.length === 1 ? "song" : "songs"} to
        </ContextMenuLabel>

        {writable.length === 0 ? (
          <ContextMenuItem disabled>No editable playlists</ContextMenuItem>
        ) : (
          writable.map((playlist) => (
            <ContextMenuItem key={playlist.id} disabled={nothingToAdd} onClick={() => addMutation.mutate(playlist.id)}>
              <span className="truncate">{playlist.name}</span>
            </ContextMenuItem>
          ))
        )}
      </ContextMenuGroup>

      <ContextMenuSeparator />
      <ContextMenuItem disabled={nothingToAdd} onClick={() => openNewPlaylistDialog(songIds)}>
        <PlusIcon className="size-4" />
        New playlist...
      </ContextMenuItem>
    </>
  );
}
