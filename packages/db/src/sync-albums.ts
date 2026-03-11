import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq, inArray, notInArray } from "drizzle-orm";
import SubsonicAPI, { type AlbumID3, type AlbumWithSongsID3, type Child } from "subsonic-api";

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
  syncStateTable,
} from "./drizzle/schema.js";
import type { AnyDrizzleDb } from "./drizzle/schema.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUM_DETAIL_CONCURRENCY = 8;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";

type Album = AlbumID3;
type AlbumWithSongs = AlbumWithSongsID3;
type Song = Child;
type SyncTransaction = AnyDrizzleDb;
type CoverArtPathResult = string | null | undefined;

type SyncedAlbum = {
  album: AlbumWithSongs;
  coverArtPath: CoverArtPathResult;
};

export interface SyncAlbumsOptions {
  coverArtDir: string;
}

export interface SyncAlbumsResult {
  fetched: number;
  inserted: number;
  updated: number;
  deleted: number;
  pages: number;
  startedAt: string;
  finishedAt: string;
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
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    return value.name;
  }

  return String(value);
}

function toAlbumRow(album: Album, coverArtPath: string | null): typeof albumsTable.$inferInsert {
  return {
    id: album.id,
    name: album.name,
    version: album.version ?? null,
    artist: album.artist ?? null,
    artistId: album.artistId ?? null,
    coverArt: album.coverArt ?? null,
    coverArtPath,
    songCount: album.songCount,
    duration: album.duration,
    playCount: album.playCount ?? null,
    created: album.created,
    starred: album.starred ?? null,
    year: album.year ?? null,
    genre: album.genre ?? null,
    played: album.played ?? null,
    userRating: album.userRating ?? null,
    musicBrainzId: album.musicBrainzId ?? null,
    displayArtist: album.displayArtist ?? null,
    sortName: album.sortName ?? null,
    originalReleaseDate: album.originalReleaseDate ?? null,
    releaseDate: album.releaseDate ?? null,
    isCompilation: album.isCompilation ?? null,
    explicitStatus: album.explicitStatus ?? null,
  };
}

function encodeAlbumCoverFilename(id: string): string {
  return encodeURIComponent(id);
}

function getAlbumCoverExtension(contentType: string | null): string {
  if (!contentType) {
    return ".jpg";
  }

  const normalized = contentType.split(";")[0]?.trim().toLowerCase();

  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/avif":
      return ".avif";
    default:
      return ".jpg";
  }
}

async function removeAlbumCoverFiles(coverArtDir: string, albumId: string): Promise<void> {
  await mkdir(coverArtDir, { recursive: true });
  const filenamePrefix = `${encodeAlbumCoverFilename(albumId)}.`;
  const entries = await readdir(coverArtDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
      .map((entry) => rm(join(coverArtDir, entry.name), { force: true })),
  );
}

async function fetchAlbumCoverArt(
  api: SubsonicAPI,
  album: Album,
  coverArtDir: string,
): Promise<string | null> {
  await mkdir(coverArtDir, { recursive: true });

  if (!album.coverArt) {
    await removeAlbumCoverFiles(coverArtDir, album.id);
    return null;
  }

  const response = await api.getCoverArt({ id: album.coverArt });
  if (!response.ok) {
    throw new Error(`Fetching album cover failed for ${album.id}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Fetching album cover failed for ${album.id}: empty response body`);
  }

  const extension = getAlbumCoverExtension(response.headers.get("content-type"));
  const outputPath = join(coverArtDir, `${encodeAlbumCoverFilename(album.id)}${extension}`);
  await removeAlbumCoverFiles(coverArtDir, album.id);
  await writeFile(outputPath, bytes);

  return outputPath;
}

async function fetchAlbumCoverArtWithRetry(
  api: SubsonicAPI,
  album: Album,
  coverArtDir: string,
): Promise<CoverArtPathResult> {
  if (!album.coverArt) {
    await removeAlbumCoverFiles(coverArtDir, album.id);
    return null;
  }

  let lastCause: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchAlbumCoverArt(api, album, coverArtDir);
    } catch (cause) {
      lastCause = cause;
    }
  }

  console.warn("Album cover fetch failed; preserving existing cached art if present.", {
    albumId: album.id,
    cause: lastCause,
  });
  return undefined;
}

function toSongRow(album: AlbumWithSongs, song: Song): typeof songsTable.$inferInsert {
  return {
    id: song.id,
    album: song.album ?? album.name,
    albumId: song.albumId ?? album.id,
    artist: song.artist ?? null,
    artistId: song.artistId ?? null,
    averageRating: song.averageRating ?? null,
    bitRate: song.bitRate ?? null,
    bookmarkPosition: song.bookmarkPosition ?? null,
    contentType: song.contentType ?? null,
    coverArt: song.coverArt ?? null,
    created: song.created ?? null,
    discNumber: song.discNumber ?? null,
    duration: song.duration ?? null,
    genre: song.genre ?? null,
    isDir: song.isDir,
    isVideo: song.isVideo ?? null,
    originalHeight: song.originalHeight ?? null,
    originalWidth: song.originalWidth ?? null,
    parent: song.parent ?? null,
    path: song.path ?? null,
    playCount: song.playCount ?? null,
    size: song.size ?? null,
    starred: song.starred ?? null,
    suffix: song.suffix ?? null,
    title: song.title,
    track: song.track ?? null,
    transcodedContentType: song.transcodedContentType ?? null,
    transcodedSuffix: song.transcodedSuffix ?? null,
    type: song.type ?? null,
    userRating: song.userRating ?? null,
    year: song.year ?? null,
    played: song.played ?? null,
    bpm: song.bpm ?? null,
    comment: song.comment ?? null,
    sortName: song.sortName ?? null,
    musicBrainzId: song.musicBrainzId ?? null,
    displayArtist: song.displayArtist ?? null,
    displayAlbumArtist: song.displayAlbumArtist ?? null,
    displayComposer: song.displayComposer ?? null,
    explicitStatus: song.explicitStatus ?? null,
  };
}

function persistAlbumRows(
  tx: SyncTransaction,
  album: Album,
  resetExistingRows: boolean,
): void {
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
    tx.insert(albumRecordLabelsTable).values(
      recordLabels.map((item, position) => ({
        albumId: album.id,
        position,
        name: item.name,
      })),
    ).run();
  }

  const genres = album.genres ?? [];
  if (genres.length > 0) {
    tx.insert(albumGenresTable).values(
      genres.map((value, position) => ({
        albumId: album.id,
        position,
        value: normalizeGenreValue(value),
      })),
    ).run();
  }

  const artists = album.artists ?? [];
  if (artists.length > 0) {
    tx.insert(albumArtistsTable).values(
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
    ).run();

    for (const [artistPosition, artist] of artists.entries()) {
      const roles = artist.roles ?? [];
      if (roles.length === 0) {
        continue;
      }

      tx.insert(albumArtistRolesTable).values(
        roles.map((role, position) => ({
          albumId: album.id,
          artistPosition,
          position,
          role,
        })),
      ).run();
    }
  }

  const releaseTypes = album.releaseTypes ?? [];
  if (releaseTypes.length > 0) {
    tx.insert(albumReleaseTypesTable).values(
      releaseTypes.map((value, position) => ({
        albumId: album.id,
        position,
        value,
      })),
    ).run();
  }

  const moods = album.moods ?? [];
  if (moods.length > 0) {
    tx.insert(albumMoodsTable).values(
      moods.map((value, position) => ({
        albumId: album.id,
        position,
        value,
      })),
    ).run();
  }

  const discTitles = album.discTitles ?? [];
  if (discTitles.length > 0) {
    tx.insert(albumDiscTitlesTable).values(
      discTitles.map((item, position) => ({
        albumId: album.id,
        position,
        disc: item.disc,
        title: item.title,
      })),
    ).run();
  }
}

function persistSongRows(
  tx: SyncTransaction,
  album: AlbumWithSongs,
  resetExistingRows: boolean,
): void {
  if (resetExistingRows) {
    tx.delete(songsTable).where(eq(songsTable.albumId, album.id)).run();
  }

  const songs = album.song ?? [];
  for (const song of songs) {
    tx
      .insert(songsTable)
      .values(toSongRow(album, song))
      .onConflictDoUpdate({
        target: songsTable.id,
        set: toSongRow(album, song),
      })
      .run();

    const genres = song.genres ?? [];
    if (genres.length > 0) {
      tx.insert(songGenresTable).values(
        genres.map((value, position) => ({
          songId: song.id,
          position,
          value: normalizeGenreValue(value),
        })),
      ).run();
    }

    const artists = song.artists ?? [];
    if (artists.length > 0) {
      tx.insert(songArtistsTable).values(
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
      ).run();

      for (const [artistPosition, artist] of artists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        tx.insert(songArtistRolesTable).values(
          roles.map((role, position) => ({
            songId: song.id,
            artistPosition,
            position,
            role,
          })),
        ).run();
      }
    }

    const albumArtists = song.albumArtists ?? [];
    if (albumArtists.length > 0) {
      tx.insert(songAlbumArtistsTable).values(
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
      ).run();

      for (const [artistPosition, artist] of albumArtists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        tx.insert(songAlbumArtistRolesTable).values(
          roles.map((role, position) => ({
            songId: song.id,
            artistPosition,
            position,
            role,
          })),
        ).run();
      }
    }

    const contributors = song.contributors ?? [];
    if (contributors.length > 0) {
      tx.insert(songContributorsTable).values(
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
      ).run();
    }

    const moods = song.moods ?? [];
    if (moods.length > 0) {
      tx.insert(songMoodsTable).values(
        moods.map((value, position) => ({
          songId: song.id,
          position,
          value,
        })),
      ).run();
    }

    if (song.replayGain) {
      tx.insert(songReplayGainTable).values({
        songId: song.id,
        trackGain: song.replayGain.trackGain,
        albumGain: song.replayGain.albumGain,
        trackPeak: song.replayGain.trackPeak,
        albumPeak: song.replayGain.albumPeak,
        baseGain: song.replayGain.baseGain,
        fallbackGain: song.replayGain.fallbackGain,
      }).run();
    }
  }
}

async function fetchAlbumDetailWithRetry(api: SubsonicAPI, album: Album): Promise<AlbumWithSongs> {
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

async function fetchAlbumDetails(
  api: SubsonicAPI,
  albums: Album[],
  coverArtDir: string,
): Promise<SyncedAlbum[]> {
  const detailedAlbums = new Array<SyncedAlbum>(albums.length);
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

async function persistPage(
  db: AnyDrizzleDb,
  albums: SyncedAlbum[],
): Promise<{ inserted: number; updated: number }> {
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

      const resolvedCoverArtPath =
        coverArtPath === undefined ? existingAlbum?.coverArtPath ?? null : coverArtPath;
      const albumRow = toAlbumRow(album, resolvedCoverArtPath);
      tx
        .insert(albumsTable)
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

async function deleteMissingAlbums(
  db: AnyDrizzleDb,
): Promise<Array<{ id: string; coverArtPath: string | null }>> {
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

async function cleanupSyncState(
  db: AnyDrizzleDb,
  finishedAt: string,
): Promise<void> {
  await db
    .insert(syncStateTable)
    .values({ key: ALBUMS_LAST_SYNCED_AT_KEY, value: finishedAt })
    .onConflictDoUpdate({
      target: syncStateTable.key,
      set: {
        value: finishedAt,
      },
    });

  await db.delete(syncAlbumIdsTable);
}

export async function syncAlbums(
  db: AnyDrizzleDb,
  api: SubsonicAPI,
  options: SyncAlbumsOptions,
): Promise<SyncAlbumsResult> {
  const startedAt = new Date().toISOString();
  await db.delete(syncAlbumIdsTable);
  await mkdir(options.coverArtDir, { recursive: true });

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
    const detailedAlbums = await fetchAlbumDetails(api, albums, options.coverArtDir);

    pages += 1;
    fetched += albums.length;

    const persisted = await persistPage(db, detailedAlbums);
    inserted += persisted.inserted;
    updated += persisted.updated;

    if (albums.length < ALBUM_PAGE_SIZE) {
      break;
    }
  }

  const deletedAlbumRows = await deleteMissingAlbums(db);
  const deleted = deletedAlbumRows.length;
  await Promise.all(
    deletedAlbumRows.map((album) => removeAlbumCoverFiles(options.coverArtDir, album.id)),
  );
  const finishedAt = new Date().toISOString();
  await cleanupSyncState(db, finishedAt);

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
