import { queryOptions } from "@tanstack/react-query";

import { DBIpc, SyncManagerIPC } from "#/lib/db";

export const appQueryKeys = {
  all: ["app"] as const,
  userState: ["app", "user"] as const,
  albums: ["app", "user", "data", "albums"] as const,
  albumDetail: (albumId: string) => ["app", "user", "data", "albums", albumId] as const,
  song: (songId: string) => ["app", "user", "data", "songs", songId] as const,
};

export const userStateQueryOptions = queryOptions({
  queryKey: appQueryKeys.userState,
  queryFn: () => SyncManagerIPC.getUserState(),
});

export const lastSyncTimeQueryOptions = queryOptions({
  queryKey: appQueryKeys.userState,
  queryFn: () => SyncManagerIPC.getUserState(),
});

export const albumsQueryOptions = queryOptions({
  queryKey: appQueryKeys.albums,
  queryFn: () => DBIpc.getAlbums(),
});

export const albumDetailQueryOptions = (albumId: string) =>
  queryOptions({
    queryKey: appQueryKeys.albumDetail(albumId),
    queryFn: () => DBIpc.getAlbumDetail(albumId),
  });

export const songQueryOptions = (songId: string) =>
  queryOptions({
    queryKey: appQueryKeys.song(songId),
    queryFn: () => DBIpc.getSongById(songId),
  });
