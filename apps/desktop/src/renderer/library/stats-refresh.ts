import { useEffect } from "react";

import { LibraryActions } from "#/library/actions";

export function useAlbumStatsRefresh(albumId: string): void {
  useEffect(() => {
    void LibraryActions.refreshStats({ type: "album", id: albumId }).catch((error: unknown) => {
      console.warn("Album stats refresh failed.", { albumId, error });
    });
  }, [albumId]);
}

export function usePlaylistSongStatsRefresh(playlistId: string | null): void {
  useEffect(() => {
    if (!playlistId) return;
    void LibraryActions.refreshStats({ type: "playlist", id: playlistId }).catch((error: unknown) => {
      console.warn("Playlist song stats refresh failed.", { playlistId, error });
    });
  }, [playlistId]);
}
