import { db } from "#/lib/db-renderer";
import { PlaylistSync } from "#/lib/playlist-sync";
import type { PlaylistSyncStatus } from "@muswag/shared";
import { useLiveQuery } from "@tanstack/react-db";
import { useSyncExternalStore } from "react";

export const useUser = () => {
  return useLiveQuery((q) => q.from({ users: db.userCredentials }).findOne());
};

export const useSyncs = () => {
  return useLiveQuery((q) => q.from({ syncs: db.syncs }));
};

export const usePlaylistSyncStatus = (): PlaylistSyncStatus => {
  return useSyncExternalStore(
    (onChange) => PlaylistSync.subscribe(onChange),
    () => PlaylistSync.getStatus(),
  );
};
