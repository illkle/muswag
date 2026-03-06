import { albumsTable } from "@muswag/db";
import { asc } from "drizzle-orm";
import { QueryClient, queryOptions } from "@tanstack/react-query";

import { db, SM } from "#/lib/db";

export const appQueryKeys = {
  all: ["app"] as const,
  data: ["data"] as const,
  userState: ["app", "user"] as const,
  albums: ["app", "data", "albums"] as const,
};

export const userStateQueryOptions = queryOptions({
  queryKey: appQueryKeys.userState,
  queryFn: () => SM.getUserState(),
});

export const albumsQueryOptions = queryOptions({
  queryKey: appQueryKeys.albums,
  queryFn: () =>
    db.select().from(albumsTable).orderBy(asc(albumsTable.artist), asc(albumsTable.name)),
});
