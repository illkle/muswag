import { mkdir } from "node:fs/promises";

import { eq, inArray, notInArray } from "drizzle-orm";
import SubsonicAPI, { type AlbumID3, type AlbumWithSongsID3 } from "subsonic-api";
import { toAlbumRow, toSongRow } from "./toDrizzle.js";

import {
  albumArtistRolesTable,
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumsTable,
  albumReleaseTypesTable,
  songAlbumArtistRolesTable,
  songAlbumArtistsTable,
  songArtistRolesTable,
  songArtistsTable,
  songContributorsTable,
  songGenresTable,
  songMoodsTable,
  songReplayGainTable,
  songsTable,
  syncAlbumIdsTable,
} from "../drizzle/schema.js";
import type { AnyDrizzleDb } from "../drizzle/schema.js";
import { fetchAlbumCoverArtWithRetry, removeAlbumCoverFiles } from "./covers-helper.js";
import type { SyncManager } from "../syncManager.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUM_DETAIL_CONCURRENCY = 8;

type SyncTransaction = AnyDrizzleDb;
type CoverArtPathResult = string | null | undefined;

type SyncedAlbum = {
  album: AlbumWithSongsID3;
  coverArtPath: CoverArtPathResult;
};

export interface SyncAlbumsOptions {
  coverArtDir: string;
}

async function retry<A>(run: () => Promise<A>, times: number): Promise<A> {
  let lastCause: unknown;

  for (let attempt = 0; attempt <= times; attempt += 1) {
    try {
      return await run();
    } catch (cause) {
      lastCause = cause;
    }
  }

  throw lastCause ?? new Error("Retry operation failed");
}

function normalizeGenreValue(value: unknown): string {
  //return value as string;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null && "name" in value && typeof value.name === "string") {
    return value.name;
  }

  return String(value);
}

function persistAlbumRows(tx: SyncTransaction, album: AlbumID3, resetExistingRows: boolean): void {
  if (resetExistingRows) {
    tx.delete(albumRecordLabelsTable).where(eq(albumRecordLabelsTable.albumId, album.id)).run();
    tx.delete(albumGenresTable).where(eq(albumGenresTable.albumId, album.id)).run();
    tx.delete(albumArtistRolesTable).where(eq(albumArtistRolesTable.albumId, album.id)).run();
    tx.delete(albumArtistsTable).where(eq(albumArtistsTable.albumId, album.id)).run();
    tx.delete(albumReleaseTypesTable).where(eq(albumReleaseTypesTable.albumId, album.id)).run();
    tx.delete(albumMoodsTable).where(eq(albumMoodsTable.albumId, album.id)).run();
    tx.delete(albumDiscTitlesTable).where(eq(albumDiscTitlesTable.albumId, album.id)).run();
  }

  const recordLabels = album.recordLabels ?? [];
  if (recordLabels.length > 0) {
    tx.insert(albumRecordLabelsTable)
      .values(
        recordLabels.map((item, position) => ({
          albumId: album.id,
          position,
          name: item.name,
        })),
      )
      .run();
  }

  const genres = album.genres ?? [];
  if (genres.length > 0) {
    tx.insert(albumGenresTable)
      .values(
        genres.map((value, position) => ({
          albumId: album.id,
          position,
          value: normalizeGenreValue(value),
        })),
      )
      .run();
  }

  const artists = album.artists ?? [];
  if (artists.length > 0) {
    tx.insert(albumArtistsTable)
      .values(
        artists.map((item, position) => ({
          albumId: album.id,
          position,
          id: item.id,
          name: item.name,
          coverArt: item.coverArt ?? null,
          artistImageUrl: item.artistImageUrl ?? null,
          albumCount: item.albumCount ?? null,
          starred: item.starred,
          musicBrainzId: item.musicBrainzId ?? null,
          sortName: item.sortName ?? null,
        })),
      )
      .run();

    for (const [artistPosition, artist] of artists.entries()) {
      const roles = artist.roles ?? [];
      if (roles.length === 0) {
        continue;
      }

      tx.insert(albumArtistRolesTable)
        .values(
          roles.map((role, position) => ({
            albumId: album.id,
            artistPosition,
            position,
            role,
          })),
        )
        .run();
    }
  }

  const releaseTypes = album.releaseTypes ?? [];
  if (releaseTypes.length > 0) {
    tx.insert(albumReleaseTypesTable)
      .values(
        releaseTypes.map((value, position) => ({
          albumId: album.id,
          position,
          value,
        })),
      )
      .run();
  }

  const moods = album.moods ?? [];
  if (moods.length > 0) {
    tx.insert(albumMoodsTable)
      .values(
        moods.map((value, position) => ({
          albumId: album.id,
          position,
          value,
        })),
      )
      .run();
  }

  const discTitles = album.discTitles ?? [];
  if (discTitles.length > 0) {
    tx.insert(albumDiscTitlesTable)
      .values(
        discTitles.map((item, position) => ({
          albumId: album.id,
          position,
          disc: item.disc,
          title: item.title,
        })),
      )
      .run();
  }
}

function persistSongRows(tx: SyncTransaction, album: AlbumWithSongsID3, resetExistingRows: boolean): void {
  if (resetExistingRows) {
    tx.delete(songsTable).where(eq(songsTable.albumId, album.id)).run();
  }

  const songs = album.song ?? [];
  for (const song of songs) {
    tx.insert(songsTable)
      .values(toSongRow(album, song))
      .onConflictDoUpdate({
        target: songsTable.id,
        set: toSongRow(album, song),
      })
      .run();

    const genres = song.genres ?? [];
    if (genres.length > 0) {
      tx.insert(songGenresTable)
        .values(
          genres.map((value, position) => ({
            songId: song.id,
            position,
            value: normalizeGenreValue(value),
          })),
        )
        .run();
    }

    const artists = song.artists ?? [];
    if (artists.length > 0) {
      tx.insert(songArtistsTable)
        .values(
          artists.map((item, position) => ({
            songId: song.id,
            position,
            id: item.id,
            name: item.name,
            coverArt: item.coverArt ?? null,
            artistImageUrl: item.artistImageUrl ?? null,
            albumCount: item.albumCount ?? null,
            starred: item.starred ?? null,
            musicBrainzId: item.musicBrainzId ?? null,
            sortName: item.sortName ?? null,
          })),
        )
        .run();

      for (const [artistPosition, artist] of artists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        tx.insert(songArtistRolesTable)
          .values(
            roles.map((role, position) => ({
              songId: song.id,
              artistPosition,
              position,
              role,
            })),
          )
          .run();
      }
    }

    const albumArtists = song.albumArtists ?? [];
    if (albumArtists.length > 0) {
      tx.insert(songAlbumArtistsTable)
        .values(
          albumArtists.map((item, position) => ({
            songId: song.id,
            position,
            id: item.id,
            name: item.name,
            coverArt: item.coverArt ?? null,
            artistImageUrl: item.artistImageUrl ?? null,
            albumCount: item.albumCount ?? null,
            starred: item.starred ?? null,
            musicBrainzId: item.musicBrainzId ?? null,
            sortName: item.sortName ?? null,
          })),
        )
        .run();

      for (const [artistPosition, artist] of albumArtists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        tx.insert(songAlbumArtistRolesTable)
          .values(
            roles.map((role, position) => ({
              songId: song.id,
              artistPosition,
              position,
              role,
            })),
          )
          .run();
      }
    }

    const contributors = song.contributors ?? [];
    if (contributors.length > 0) {
      tx.insert(songContributorsTable)
        .values(
          contributors.map((item, position) => ({
            songId: song.id,
            position,
            role: item.role,
            subRole: item.subRole ?? null,
            artistId: item.artist?.id ?? null,
            artistName: item.artist?.name ?? null,
            coverArt: item.artist?.coverArt ?? null,
            artistImageUrl: item.artist?.artistImageUrl ?? null,
            albumCount: item.artist?.albumCount ?? null,
            starred: item.artist?.starred ?? null,
            musicBrainzId: item.artist?.musicBrainzId ?? null,
            sortName: item.artist?.sortName ?? null,
          })),
        )
        .run();
    }

    const moods = song.moods ?? [];
    if (moods.length > 0) {
      tx.insert(songMoodsTable)
        .values(
          moods.map((value, position) => ({
            songId: song.id,
            position,
            value,
          })),
        )
        .run();
    }

    if (song.replayGain) {
      tx.insert(songReplayGainTable)
        .values({
          songId: song.id,
          trackGain: song.replayGain.trackGain,
          albumGain: song.replayGain.albumGain,
          trackPeak: song.replayGain.trackPeak,
          albumPeak: song.replayGain.albumPeak,
          baseGain: song.replayGain.baseGain,
          fallbackGain: song.replayGain.fallbackGain,
        })
        .run();
    }
  }
}

async function fetchAlbumDetailWithRetry(api: SubsonicAPI, album: AlbumID3): Promise<AlbumWithSongsID3> {
  let lastCause: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = await api.getAlbum({ id: album.id });
      return payload.album;
    } catch (cause) {
      lastCause = cause;
    }
  }

  throw lastCause ?? new Error(`Fetching album detail failed for ${album.id}`);
}

async function fetchAlbumDetails(api: SubsonicAPI, albums: AlbumID3[], coverArtDir: string): Promise<SyncedAlbum[]> {
  const detailedAlbums: SyncedAlbum[] = [];
  let nextIndex = 0;

  const workerCount = Math.min(ALBUM_DETAIL_CONCURRENCY, albums.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= albums.length) {
          return;
        }

        const listedAlbum = albums[currentIndex]!;
        const detailedAlbum = await fetchAlbumDetailWithRetry(api, listedAlbum);
        const coverArtPath = await fetchAlbumCoverArtWithRetry(api, detailedAlbum, coverArtDir);
        detailedAlbums[currentIndex] = {
          album: detailedAlbum,
          coverArtPath,
        };
      }
    }),
  );

  return detailedAlbums;
}

async function persistPage(db: AnyDrizzleDb, albums: SyncedAlbum[]): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;
  const albumIds = albums.map(({ album }) => album.id);
  const existingAlbums =
    albumIds.length === 0
      ? []
      : await db
          .select({
            id: albumsTable.id,
            coverArtPath: albumsTable.coverArtPath,
          })
          .from(albumsTable)
          .where(inArray(albumsTable.id, albumIds));
  const existingAlbumsById = new Map(existingAlbums.map((row) => [row.id, row]));

  db.transaction((tx) => {
    for (const { album, coverArtPath } of albums) {
      const existingAlbum = existingAlbumsById.get(album.id);
      const exists = existingAlbum !== undefined;

      if (exists) {
        updated += 1;
      } else {
        inserted += 1;
      }

      const resolvedCoverArtPath = coverArtPath === undefined ? (existingAlbum?.coverArtPath ?? null) : coverArtPath;
      const albumRow = toAlbumRow(album, resolvedCoverArtPath);
      tx.insert(albumsTable)
        .values(albumRow)
        .onConflictDoUpdate({
          target: albumsTable.id,
          set: albumRow,
        })
        .run();

      tx.insert(syncAlbumIdsTable).values({ id: album.id }).onConflictDoNothing().run();
      persistAlbumRows(tx, album, exists);
      persistSongRows(tx, album, exists);
    }
  });

  return { inserted, updated };
}

async function deleteMissingAlbums(db: AnyDrizzleDb): Promise<Array<{ id: string; coverArtPath: string | null }>> {
  const existingIdsSubquery = db.select({ id: syncAlbumIdsTable.id }).from(syncAlbumIdsTable);
  const albumsToDelete = await db
    .select({
      id: albumsTable.id,
      coverArtPath: albumsTable.coverArtPath,
    })
    .from(albumsTable)
    .where(notInArray(albumsTable.id, existingIdsSubquery));

  await db.delete(albumsTable).where(notInArray(albumsTable.id, existingIdsSubquery));

  return albumsToDelete;
}

export async function syncAlbums(sm: SyncManager) {
  if (!sm.api) {
    throw new Error("no api on sm");
  }

  const api = sm.api;

  const startedAt = new Date().toISOString();
  await sm.db.delete(syncAlbumIdsTable);
  await mkdir(sm.coverArtDir, { recursive: true });

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pages = 0;

  for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
    const payload = await retry(
      () =>
        api.getAlbumList2({
          type: "alphabeticalByArtist",
          size: ALBUM_PAGE_SIZE,
          offset,
        }),
      2,
    );

    const albums = payload.albumList2?.album ?? [];
    const detailedAlbums = await fetchAlbumDetails(api, albums, sm.coverArtDir);

    pages += 1;
    fetched += albums.length;

    const persisted = await persistPage(sm.db, detailedAlbums);
    inserted += persisted.inserted;
    updated += persisted.updated;

    sm.emit({ type: "update", process: "Albums", count: fetched });

    if (albums.length < ALBUM_PAGE_SIZE) {
      break;
    }
  }

  const deletedAlbumRows = await deleteMissingAlbums(sm.db);
  const deleted = deletedAlbumRows.length;
  await Promise.all(deletedAlbumRows.map((album) => removeAlbumCoverFiles(sm.coverArtDir, album.id)));
  const finishedAt = new Date().toISOString();
  await sm.db.delete(syncAlbumIdsTable);

  return {
    fetched,
    inserted,
    updated,
    deleted,
    pages,
    startedAt,
    finishedAt,
  };
}
