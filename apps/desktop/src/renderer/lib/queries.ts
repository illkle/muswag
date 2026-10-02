import { IDLE_PLAYLIST_SYNC, type PlaylistSyncStatus } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";

import { appState } from "./state-mirror";

export const useUser = () => {
  const session = useLiveQuery((q) => q.from({ auth: appState.auth }).findOne()).data?.value;
  return {
    data: session?._tag === "LoggedIn" ? { url: session.url, username: session.username } : undefined,
    isLoading: !session || session._tag === "Initializing",
  };
};

export const usePlaylistSyncStatus = (): PlaylistSyncStatus => useLiveQuery((q) => q.from({ status: appState.playlistSync }).findOne()).data?.value ?? IDLE_PLAYLIST_SYNC;
