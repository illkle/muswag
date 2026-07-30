import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { Menu, MenuContent, MenuGroupLabel, MenuItem, MenuSeparator, MenuTrigger } from "#/components/ui/menu";
import { PlaylistActions } from "#/lib/playlist-actions";
import { usePlaylists } from "#/lib/playlist-queries";
import { useMutation } from "@tanstack/react-query";
import { ListPlus, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Adds `songIds` to an existing playlist or a brand new one. Read-only playlists (owned by another
 * user) are left out, since the controls would throw on them.
 */
export function AddToPlaylistMenu({ songIds, children }: { songIds: readonly string[]; children?: ReactNode }) {
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
        <MenuTrigger
          disabled={disabled}
          render={
            children ? undefined : (
              <button
                type="button"
                aria-label="Add to playlist"
                className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
              />
            )
          }
        >
          {children ?? <ListPlus className="size-4" />}
        </MenuTrigger>

        <MenuContent>
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
