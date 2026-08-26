import { AppClient } from "#/core/client";
import type { PlaylistSyncStatus } from "@muswag/shared";
import { useSyncExternalStore } from "react";

export const useUser = () => {
  const snapshot = useSyncExternalStore(AppClient.subscribeAuth, AppClient.getAuthSnapshot);
  return {
    data: snapshot._tag === "LoggedIn" ? { url: snapshot.url, username: snapshot.username } : undefined,
    isLoading: snapshot._tag === "Initializing",
  };
};

export const usePlaylistSyncStatus = (): PlaylistSyncStatus => {
  return useSyncExternalStore(AppClient.subscribePlaylistSync, AppClient.getPlaylistSyncStatus);
};
