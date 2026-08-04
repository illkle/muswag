import { PlaylistActions } from "#/lib/playlist-actions";
import { usePlaylists } from "#/lib/playlist-queries";
import { useMutation } from "@tanstack/react-query";
import { PlusIcon } from "@phosphor-icons/react";

import { ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "#/components/ui/context-menu";

export function AddToPlaylistMenu({ songIds, setCreateOpen }: { songIds: readonly string[]; setCreateOpen: (v: boolean) => void }) {
  const { playlists } = usePlaylists();

  const addMutation = useMutation({
    mutationFn: (playlistId: string) => PlaylistActions.addSongs(playlistId, songIds),
  });

  const writable = playlists.filter(({ readonly }) => !readonly);

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
            <ContextMenuItem key={playlist.id} onClick={() => addMutation.mutate(playlist.id)}>
              <span className="truncate">{playlist.name}</span>
            </ContextMenuItem>
          ))
        )}
      </ContextMenuGroup>

      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => setCreateOpen(true)}>
        <PlusIcon className="size-4" />
        New playlist...
      </ContextMenuItem>
    </>
  );
}
