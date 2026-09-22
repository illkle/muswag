import { useEffect } from "react";

import { AppClient } from "#/core/client";

export function useAlbumStatsRefresh(albumId: string): void {
  useEffect(() => {
    void AppClient.refreshStats({ type: "album", id: albumId }).catch((error: unknown) => {
      console.warn("Album stats refresh failed.", { albumId, error });
    });
  }, [albumId]);
}

export function usePlaylistSongStatsRefresh(playlistId: string | null): void {
  useEffect(() => {
    if (!playlistId) return;
    void AppClient.refreshStats({ type: "playlist", id: playlistId }).catch((error: unknown) => {
      console.warn("Playlist song stats refresh failed.", { playlistId, error });
    });
  }, [playlistId]);
}
