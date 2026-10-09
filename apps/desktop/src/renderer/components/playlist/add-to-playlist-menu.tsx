import { PlaylistActions } from "#/playlists/actions";
import { usePlaylists } from "#/playlists/queries";
import { PlusIcon } from "@phosphor-icons/react";

import { openNewPlaylistDialog } from "#/components/playlist/new-playlist-dialog";
import { ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "#/components/ui/context-menu";
import { failureNotice } from "#/lib/notify";

export function AddToPlaylistMenu({ songIds }: { songIds: readonly string[] }) {
  const { playlists } = usePlaylists();

  const writable = playlists.filter(({ readonly }) => !readonly);
  const nothingToAdd = songIds.length === 0;
  const what = songIds.length === 1 ? "song" : "songs";

  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>
          Add {songIds.length} {what} to
        </ContextMenuLabel>

        {writable.length === 0 ? (
          <ContextMenuItem disabled>No editable playlists</ContextMenuItem>
        ) : (
          writable.map((playlist) => (
            <ContextMenuItem
              key={playlist.id}
              disabled={nothingToAdd}
              // The menu is gone by the time this can fail, so the failure is a notice.
              onClick={() => void PlaylistActions.addSongs(playlist.id, songIds).catch(failureNotice(`The ${what} could not be added to “${playlist.name}”.`))}
            >
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
