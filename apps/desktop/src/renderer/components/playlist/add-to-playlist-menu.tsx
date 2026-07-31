import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { PlaylistActions } from "#/lib/playlist-actions";
import { usePlaylists } from "#/lib/playlist-queries";
import { useMutation } from "@tanstack/react-query";
import { ListPlus, Plus } from "lucide-react";
import { useState, type ReactElement } from "react";

/**
 * Adds `songIds` to an existing playlist or a brand new one. Read-only playlists (owned by another
 * user) are left out, since the controls would throw on them.
 *
 * `trigger` is handed to the menu's `render` prop rather than nested inside it, so a caller passing
 * a Button does not end up with a button inside a button.
 */
export function AddToPlaylistMenu({ songIds, trigger }: { songIds: readonly string[]; trigger?: ReactElement }) {
  const { playlists } = usePlaylists();
  const [createOpen, setCreateOpen] = useState(false);

  const addMutation = useMutation({
    mutationFn: (playlistId: string) => PlaylistActions.addSongs(playlistId, songIds),
  });

  const writable = playlists.filter(({ readonly }) => !readonly);
  const disabled = songIds.length === 0;

  return (
    <>
      <Menu>
        {trigger ? (
          <MenuTrigger disabled={disabled} render={trigger} />
        ) : (
          <MenuTrigger
            disabled={disabled}
            aria-label="Add to playlist"
            className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
            onClick={(event) => event.stopPropagation()}
          >
            <ListPlus className="size-4" />
          </MenuTrigger>
        )}

        <MenuContent>
          <MenuGroup>
            <MenuGroupLabel>
              Add {songIds.length} {songIds.length === 1 ? "song" : "songs"} to
            </MenuGroupLabel>

            {writable.length === 0 ? (
              <MenuItem disabled>No editable playlists</MenuItem>
            ) : (
              writable.map((playlist) => (
                <MenuItem key={playlist.id} onClick={() => addMutation.mutate(playlist.id)}>
                  <span className="truncate">{playlist.name}</span>
                </MenuItem>
              ))
            )}
          </MenuGroup>

          <MenuSeparator />
          <MenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New playlist...
          </MenuItem>
        </MenuContent>
      </Menu>

      <PlaylistFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New playlist"
        submitLabel="Create"
        onSubmit={async ({ name, comment, public: isPublic }) => {
          const created = await PlaylistActions.createWithSongs(name, songIds);
          if (comment) await PlaylistActions.setComment(created.id, comment);
          if (isPublic) await PlaylistActions.setVisibility(created.id, true);
        }}
      />
    </>
  );
}
