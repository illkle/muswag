import { queryOptions } from "@tanstack/react-query";

import { dbHooks, SM } from "#/lib/db";

export const appQueryKeys = {
  all: ["app"] as const,
  data: ["data"] as const,
  userState: ["app", "user"] as const,
  albums: ["app", "data", "albums"] as const,
  albumDetail: (albumId: string) => ["app", "data", "albums", albumId] as const,
  song: (songId: string) => ["app", "data", "songs", songId] as const,
};

export const userStateQueryOptions = queryOptions({
  queryKey: appQueryKeys.userState,
  queryFn: () => SM.getUserState(),
});

export const albumsQueryOptions = queryOptions({
  queryKey: appQueryKeys.albums,
  queryFn: () => dbHooks.getAlbums(),
});

export const albumDetailQueryOptions = (albumId: string) =>
  queryOptions({
    queryKey: appQueryKeys.albumDetail(albumId),
    queryFn: () => dbHooks.getAlbumDetail(albumId),
  });

export const songQueryOptions = (songId: string) =>
  queryOptions({
    queryKey: appQueryKeys.song(songId),
    queryFn: () => dbHooks.getSongById(songId),
  });
