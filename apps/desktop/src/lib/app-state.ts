import {
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumReleaseTypesTable,
  albumsTable,
  songsTable,
} from "@muswag/db";
import { asc, eq } from "drizzle-orm";
import { queryOptions } from "@tanstack/react-query";

import { db, SM } from "#/lib/db";

export const appQueryKeys = {
  all: ["app"] as const,
  data: ["data"] as const,
  userState: ["app", "user"] as const,
  albums: ["app", "data", "albums"] as const,
  albumDetail: (albumId: string) => ["app", "data", "albums", albumId] as const,
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

export const albumDetailQueryOptions = (albumId: string) =>
  queryOptions({
    queryKey: appQueryKeys.albumDetail(albumId),
    queryFn: async () => {
      const albumRows = await db
        .select()
        .from(albumsTable)
        .where(eq(albumsTable.id, albumId))
        .limit(1);

      const album = albumRows[0];
      if (!album) {
        return null;
      }

      const [recordLabels, genres, artists, releaseTypes, moods, discTitles, songs] =
        await Promise.all([
          db
            .select()
            .from(albumRecordLabelsTable)
            .where(eq(albumRecordLabelsTable.albumId, albumId))
            .orderBy(asc(albumRecordLabelsTable.position)),
          db
            .select()
            .from(albumGenresTable)
            .where(eq(albumGenresTable.albumId, albumId))
            .orderBy(asc(albumGenresTable.position)),
          db
            .select()
            .from(albumArtistsTable)
            .where(eq(albumArtistsTable.albumId, albumId))
            .orderBy(asc(albumArtistsTable.position)),
          db
            .select()
            .from(albumReleaseTypesTable)
            .where(eq(albumReleaseTypesTable.albumId, albumId))
            .orderBy(asc(albumReleaseTypesTable.position)),
          db
            .select()
            .from(albumMoodsTable)
            .where(eq(albumMoodsTable.albumId, albumId))
            .orderBy(asc(albumMoodsTable.position)),
          db
            .select()
            .from(albumDiscTitlesTable)
            .where(eq(albumDiscTitlesTable.albumId, albumId))
            .orderBy(asc(albumDiscTitlesTable.position)),
          db
            .select()
            .from(songsTable)
            .where(eq(songsTable.albumId, albumId))
            .orderBy(asc(songsTable.discNumber), asc(songsTable.track), asc(songsTable.title)),
        ]);

      return {
        album,
        recordLabels,
        genres,
        artists,
        releaseTypes,
        moods,
        discTitles,
        songs,
      };
    },
  });
