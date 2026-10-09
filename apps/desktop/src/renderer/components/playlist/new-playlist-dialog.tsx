import { createStore, useStore } from "@tanstack/react-store";
import { useNavigate } from "@tanstack/react-router";

import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistActions } from "#/playlists/actions";

/** The songs a new playlist is being made from, while the dialog asking for its details is open. */
const pendingSongIds = createStore<readonly string[] | null>(null);

/** Asks for the details of a new playlist, which will hold `songIds` when there are any. */
export function openNewPlaylistDialog(songIds: readonly string[] = []) {
  pendingSongIds.setState(() => songIds);
}

/** The dialog `openNewPlaylistDialog` opens. Mounted once, so anything in the app can use it. */
export function NewPlaylistDialog() {
  const songIds = useStore(pendingSongIds);
  const navigate = useNavigate();

  return (
    <PlaylistFormDialog
      open={songIds !== null}
      onOpenChange={(open) => {
        if (!open) pendingSongIds.setState(() => null);
      }}
      title="New playlist"
      submitLabel="Create"
      onSubmit={async (details) => {
        const created = await PlaylistActions.create({ ...details, songIds: [...(songIds ?? [])] });
        // An empty playlist is opened, there being nothing else to do with it. One made from songs leaves the user with what they were looking at.
        if (!songIds?.length) await navigate({ to: "/app/playlists/$playlistId", params: { playlistId: created.id } });
      }}
    />
  );
}
