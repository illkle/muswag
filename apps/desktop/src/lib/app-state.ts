import { albumsTable, type SyncManagerEvent } from "@muswag/db";
import { asc } from "drizzle-orm";
import { QueryClient, queryOptions } from "@tanstack/react-query";

import { db, SM } from "#/lib/db";

export const appQueryKeys = {
  all: ["app"] as const,
  userState: ["app", "user-state"] as const,
  albums: ["app", "albums"] as const,
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

export function applyAppEvent(queryClient: QueryClient, event: SyncManagerEvent): void {
  if (event.type === "user update") {
    queryClient.setQueryData(appQueryKeys.userState, event.userState);
  }
}
