import { useEffect } from "react";

import { LibraryActions } from "#/library/actions";

/** Reads the album and its songs from the server again when its page opens, which catches what a sync passed over. */
export function useAlbumRefresh(albumId: string): void {
  useEffect(() => {
    void LibraryActions.refresh({ type: "album", id: albumId }).catch((error: unknown) => {
      console.warn("Album refresh failed.", { albumId, error });
    });
  }, [albumId]);
}

/** Reads the songs of the playlist with server id `playlistId` again when its page opens. */
export function usePlaylistSongsRefresh(playlistId: string | null): void {
  useEffect(() => {
    if (!playlistId) return;
    void LibraryActions.refresh({ type: "playlist", id: playlistId }).catch((error: unknown) => {
      console.warn("Playlist songs refresh failed.", { playlistId, error });
    });
  }, [playlistId]);
}
