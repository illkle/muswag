import { db } from "#/lib/db-renderer";
import { createSubsonicApi, getUserInfo, refreshAlbumStats, refreshPlaylistSongStats } from "#core";
import { useEffect } from "react";

function currentApi(): ReturnType<typeof createSubsonicApi> | null {
  const user = getUserInfo(db);
  if (!user) return null;
  return createSubsonicApi(user);
}

export function useAlbumStatsRefresh(albumId: string): void {
  useEffect(() => {
    const api = currentApi();
    if (!api) return;
    void refreshAlbumStats(db, api, albumId).catch((error: unknown) => {
      console.warn("Album stats refresh failed.", { albumId, error });
    });
  }, [albumId]);
}

export function usePlaylistSongStatsRefresh(playlistId: string | null): void {
  useEffect(() => {
    if (!playlistId) return;
    const api = currentApi();
    if (!api) return;
    void refreshPlaylistSongStats(db, api, playlistId).catch((error: unknown) => {
      console.warn("Playlist song stats refresh failed.", { playlistId, error });
    });
  }, [playlistId]);
}
