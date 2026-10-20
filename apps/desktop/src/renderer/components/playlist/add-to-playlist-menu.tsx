import { PlaylistActions } from "#/playlists/actions";
import { usePlaylists } from "#/playlists/queries";
import { PlusIcon } from "@phosphor-icons/react";

import { openNewPlaylistDialog } from "#/components/playlist/new-playlist-dialog";
import { ContextMenuGroup, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "#/components/ui/context-menu";
import { failureNotice } from "#/lib/notify";

/** Adds `count` songs to a playlist. Their ids are asked for once one is picked: a list that holds only the rows in view has to ask main for them. */
export function AddToPlaylistMenu({ count, songIds }: { count: number; songIds: () => Promise<readonly string[]> }) {
  const { playlists } = usePlaylists();

  const writable = playlists.filter(({ readonly }) => !readonly);
  const nothingToAdd = count === 0;
  const what = count === 1 ? "song" : "songs";

  return (
    <>
      <ContextMenuGroup>
        <ContextMenuLabel>
          Add {count} {what} to
        </ContextMenuLabel>

        {writable.length === 0 ? (
          <ContextMenuItem disabled>No editable playlists</ContextMenuItem>
        ) : (
          writable.map((playlist) => (
            <ContextMenuItem
              key={playlist.id}
              disabled={nothingToAdd}
              // The menu is gone by the time this can fail, so the failure is a notice.
              onClick={() =>
                void songIds()
                  .then((ids) => PlaylistActions.addSongs(playlist.id, ids))
                  .catch(failureNotice(`The ${what} could not be added to “${playlist.name}”.`))
              }
            >
              <span className="truncate">{playlist.name}</span>
            </ContextMenuItem>
          ))
        )}
      </ContextMenuGroup>

      <ContextMenuSeparator />
      <ContextMenuItem disabled={nothingToAdd} onClick={() => void songIds().then(openNewPlaylistDialog, failureNotice(`The ${what} could not be read.`))}>
        <PlusIcon className="size-4" />
        New playlist...
      </ContextMenuItem>
    </>
  );
}
