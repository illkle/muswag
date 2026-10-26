import type { PlaylistDetails } from "@muswag/model";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistActions } from "#/playlists/actions";

/** Changes the name, comment and visibility of the playlist `playlistId`, from its page or the sidebar. */
export function PlaylistEditDialog({ playlistId, details, open, onOpenChange }: { playlistId: string; details: PlaylistDetails; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <PlaylistFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Playlist details"
      submitLabel="Save"
      initialValues={details}
      onSubmit={async ({ name, comment, public: isPublic }) => {
        if (name.trim() !== details.name) await PlaylistActions.rename(playlistId, name);
        if (comment !== details.comment) await PlaylistActions.setComment(playlistId, comment);
        if (isPublic !== details.public) await PlaylistActions.setVisibility(playlistId, isPublic);
      }}
    />
  );
}
