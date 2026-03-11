import { asc, eq } from "drizzle-orm";

import type { AnyDrizzleDb } from "./drizzle/schema.js";
import {
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumReleaseTypesTable,
  albumsTable,
  songsTable,
} from "./drizzle/schema.js";

export type GetSongsInput = {
  albumId?: string;
};

export type AlbumRecord = typeof albumsTable.$inferSelect;
export type SongRecord = typeof songsTable.$inferSelect;
export type AlbumRecordLabel = typeof albumRecordLabelsTable.$inferSelect;
export type AlbumGenre = typeof albumGenresTable.$inferSelect;
export type AlbumArtist = typeof albumArtistsTable.$inferSelect;
export type AlbumReleaseType = typeof albumReleaseTypesTable.$inferSelect;
export type AlbumMood = typeof albumMoodsTable.$inferSelect;
export type AlbumDiscTitle = typeof albumDiscTitlesTable.$inferSelect;

export interface AlbumDetail {
  album: AlbumRecord;
  recordLabels: AlbumRecordLabel[];
  genres: AlbumGenre[];
  artists: AlbumArtist[];
  releaseTypes: AlbumReleaseType[];
  moods: AlbumMood[];
  discTitles: AlbumDiscTitle[];
  songs: SongRecord[];
}

export async function getAlbums(db: AnyDrizzleDb): Promise<AlbumRecord[]> {
  return db.select().from(albumsTable).orderBy(asc(albumsTable.artist), asc(albumsTable.name));
}

export async function getSongs(db: AnyDrizzleDb, input: GetSongsInput = {}): Promise<SongRecord[]> {
  if (input.albumId) {
    return db
      .select()
      .from(songsTable)
      .where(eq(songsTable.albumId, input.albumId))
      .orderBy(asc(songsTable.discNumber), asc(songsTable.track), asc(songsTable.title));
  }

  return db
    .select()
    .from(songsTable)
    .orderBy(
      asc(songsTable.albumId),
      asc(songsTable.discNumber),
      asc(songsTable.track),
      asc(songsTable.title),
    );
}

export async function getSongById(db: AnyDrizzleDb, songId: string): Promise<SongRecord | null> {
  const rows = await db.select().from(songsTable).where(eq(songsTable.id, songId)).limit(1);
  return rows[0] ?? null;
}

export async function getAlbumDetail(
  db: AnyDrizzleDb,
  albumId: string,
): Promise<AlbumDetail | null> {
  const albumRows = await db.select().from(albumsTable).where(eq(albumsTable.id, albumId)).limit(1);
  const album = albumRows[0];

  if (!album) {
    return null;
  }

  const [recordLabels, genres, artists, releaseTypes, moods, discTitles, songs] = await Promise.all(
    [
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
      getSongs(db, { albumId }),
    ],
  );

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
}

export type GetAlbumsResult = Awaited<ReturnType<typeof getAlbums>>;
export type GetSongsResult = Awaited<ReturnType<typeof getSongs>>;
export type GetSongByIdResult = Awaited<ReturnType<typeof getSongById>>;
export type GetAlbumDetailResult = Awaited<ReturnType<typeof getAlbumDetail>>;
