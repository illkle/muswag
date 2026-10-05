import { createStore, useStore } from "@tanstack/react-store";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistActions } from "#/playlists/actions";

/** The songs a new playlist is being made from, while the dialog asking for its details is open. */
const pendingSongIds = createStore<readonly string[] | null>(null);

/** Asks for the details of a new playlist that will hold `songIds`. */
export function openNewPlaylistDialog(songIds: readonly string[]) {
  pendingSongIds.setState(() => songIds);
}

/** The dialog `openNewPlaylistDialog` opens. Mounted once, so any menu in the app can use it. */
export function NewPlaylistDialog() {
  const songIds = useStore(pendingSongIds);

  return (
    <PlaylistFormDialog
      open={songIds !== null}
      onOpenChange={(open) => {
        if (!open) pendingSongIds.setState(() => null);
      }}
      title="New playlist"
      submitLabel="Create"
      onSubmit={(details) => PlaylistActions.create({ ...details, songIds: [...(songIds ?? [])] })}
    />
  );
}
