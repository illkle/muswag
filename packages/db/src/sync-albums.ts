import { eq, inArray, notInArray, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
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
import type { DrizzleDb } from "./drizzle/schema.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUM_DETAIL_CONCURRENCY = 8;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";

type Album = AlbumID3;
type AlbumWithSongs = AlbumWithSongsID3;
type Song = Child;
type SyncTransaction = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

export interface SyncAlbumsResult {
  fetched: number;
  inserted: number;
  updated: number;
  deleted: number;
  pages: number;
  startedAt: string;
  finishedAt: string;
}

export class SyncAlbumsApiError extends Data.TaggedError("SyncAlbumsApiError")<{
  message: string;
  cause: unknown;
}> {}

export class SyncAlbumsDatabaseError extends Data.TaggedError("SyncAlbumsDatabaseError")<{
  message: string;
  cause: unknown;
}> {}

function dbEffect<A>(message: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new SyncAlbumsDatabaseError({ message, cause }),
  });
}

function apiEffect<A>(message: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new SyncAlbumsApiError({ message, cause }),
  });
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

function toAlbumRow(album: Album): typeof albumsTable.$inferInsert {
  return {
    id: album.id,
    name: album.name,
    version: album.version ?? null,
    artist: album.artist ?? null,
    artistId: album.artistId ?? null,
    coverArt: album.coverArt ?? null,
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

async function persistAlbumRows(
  tx: SyncTransaction,
  album: Album,
  resetExistingRows: boolean,
): Promise<void> {
  if (resetExistingRows) {
    await tx.delete(albumRecordLabelsTable).where(eq(albumRecordLabelsTable.albumId, album.id));
    await tx.delete(albumGenresTable).where(eq(albumGenresTable.albumId, album.id));
    await tx.delete(albumArtistRolesTable).where(eq(albumArtistRolesTable.albumId, album.id));
    await tx.delete(albumArtistsTable).where(eq(albumArtistsTable.albumId, album.id));
    await tx.delete(albumReleaseTypesTable).where(eq(albumReleaseTypesTable.albumId, album.id));
    await tx.delete(albumMoodsTable).where(eq(albumMoodsTable.albumId, album.id));
    await tx.delete(albumDiscTitlesTable).where(eq(albumDiscTitlesTable.albumId, album.id));
  }

  const recordLabels = album.recordLabels ?? [];
  if (recordLabels.length > 0) {
    await tx.insert(albumRecordLabelsTable).values(
      recordLabels.map((item, position) => ({
        albumId: album.id,
        position,
        name: item.name,
      })),
    );
  }

  const genres = album.genres ?? [];
  if (genres.length > 0) {
    await tx.insert(albumGenresTable).values(
      genres.map((value, position) => ({
        albumId: album.id,
        position,
        value: normalizeGenreValue(value),
      })),
    );
  }

  const artists = album.artists ?? [];
  if (artists.length > 0) {
    await tx.insert(albumArtistsTable).values(
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
    );

    for (const [artistPosition, artist] of artists.entries()) {
      const roles = artist.roles ?? [];
      if (roles.length === 0) {
        continue;
      }

      await tx.insert(albumArtistRolesTable).values(
        roles.map((role, position) => ({
          albumId: album.id,
          artistPosition,
          position,
          role,
        })),
      );
    }
  }

  const releaseTypes = album.releaseTypes ?? [];
  if (releaseTypes.length > 0) {
    await tx.insert(albumReleaseTypesTable).values(
      releaseTypes.map((value, position) => ({
        albumId: album.id,
        position,
        value,
      })),
    );
  }

  const moods = album.moods ?? [];
  if (moods.length > 0) {
    await tx.insert(albumMoodsTable).values(
      moods.map((value, position) => ({
        albumId: album.id,
        position,
        value,
      })),
    );
  }

  const discTitles = album.discTitles ?? [];
  if (discTitles.length > 0) {
    await tx.insert(albumDiscTitlesTable).values(
      discTitles.map((item, position) => ({
        albumId: album.id,
        position,
        disc: item.disc,
        title: item.title,
      })),
    );
  }
}

async function persistSongRows(
  tx: SyncTransaction,
  album: AlbumWithSongs,
  resetExistingRows: boolean,
): Promise<void> {
  if (resetExistingRows) {
    await tx.delete(songsTable).where(eq(songsTable.albumId, album.id));
  }

  const songs = album.song ?? [];
  for (const song of songs) {
    await tx
      .insert(songsTable)
      .values(toSongRow(album, song))
      .onConflictDoUpdate({
        target: songsTable.id,
        set: toSongRow(album, song),
      });

    const genres = song.genres ?? [];
    if (genres.length > 0) {
      await tx.insert(songGenresTable).values(
        genres.map((value, position) => ({
          songId: song.id,
          position,
          value: normalizeGenreValue(value),
        })),
      );
    }

    const artists = song.artists ?? [];
    if (artists.length > 0) {
      await tx.insert(songArtistsTable).values(
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
      );

      for (const [artistPosition, artist] of artists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        await tx.insert(songArtistRolesTable).values(
          roles.map((role, position) => ({
            songId: song.id,
            artistPosition,
            position,
            role,
          })),
        );
      }
    }

    const albumArtists = song.albumArtists ?? [];
    if (albumArtists.length > 0) {
      await tx.insert(songAlbumArtistsTable).values(
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
      );

      for (const [artistPosition, artist] of albumArtists.entries()) {
        const roles = artist.roles ?? [];
        if (roles.length === 0) {
          continue;
        }

        await tx.insert(songAlbumArtistRolesTable).values(
          roles.map((role, position) => ({
            songId: song.id,
            artistPosition,
            position,
            role,
          })),
        );
      }
    }

    const contributors = song.contributors ?? [];
    if (contributors.length > 0) {
      await tx.insert(songContributorsTable).values(
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
      );
    }

    const moods = song.moods ?? [];
    if (moods.length > 0) {
      await tx.insert(songMoodsTable).values(
        moods.map((value, position) => ({
          songId: song.id,
          position,
          value,
        })),
      );
    }

    if (song.replayGain) {
      await tx.insert(songReplayGainTable).values({
        songId: song.id,
        trackGain: song.replayGain.trackGain,
        albumGain: song.replayGain.albumGain,
        trackPeak: song.replayGain.trackPeak,
        albumPeak: song.replayGain.albumPeak,
        baseGain: song.replayGain.baseGain,
        fallbackGain: song.replayGain.fallbackGain,
      });
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

  throw new SyncAlbumsApiError({
    message: `Fetching album detail failed for ${album.id}`,
    cause: lastCause,
  });
}

function fetchAlbumDetails(
  api: SubsonicAPI,
  albums: Album[],
): Effect.Effect<AlbumWithSongs[], SyncAlbumsApiError> {
  return Effect.tryPromise({
    try: async () => {
      const detailedAlbums = new Array<AlbumWithSongs>(albums.length);
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

            detailedAlbums[currentIndex] = await fetchAlbumDetailWithRetry(
              api,
              albums[currentIndex]!,
            );
          }
        }),
      );

      return detailedAlbums;
    },
    catch: (cause) =>
      cause instanceof SyncAlbumsApiError
        ? cause
        : new SyncAlbumsApiError({
            message: "Fetching album details failed",
            cause,
          }),
  });
}

function persistPage(
  db: DrizzleDb,
  albums: AlbumWithSongs[],
): Effect.Effect<{ inserted: number; updated: number }, SyncAlbumsDatabaseError> {
  return dbEffect("Persisting album page failed", async () => {
    let inserted = 0;
    let updated = 0;
    const albumIds = albums.map((album) => album.id);
    const existingIds =
      albumIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db
                .select({ id: albumsTable.id })
                .from(albumsTable)
                .where(inArray(albumsTable.id, albumIds))
            ).map((row) => row.id),
          );

    await db.transaction(async (tx) => {
      for (const album of albums) {
        const exists = existingIds.has(album.id);

        if (exists) {
          updated += 1;
        } else {
          inserted += 1;
        }

        const albumRow = toAlbumRow(album);
        await tx
          .insert(albumsTable)
          .values(albumRow)
          .onConflictDoUpdate({
            target: albumsTable.id,
            set: albumRow,
          });

        await tx.insert(syncAlbumIdsTable).values({ id: album.id }).onConflictDoNothing();
        await persistAlbumRows(tx, album, exists);
        await persistSongRows(tx, album, exists);
      }
    });

    return { inserted, updated };
  });
}

function deleteMissingAlbums(db: DrizzleDb): Effect.Effect<number, SyncAlbumsDatabaseError> {
  return dbEffect("Deleting stale albums failed", async () => {
    const existingIdsSubquery = db.select({ id: syncAlbumIdsTable.id }).from(syncAlbumIdsTable);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(albumsTable)
      .where(notInArray(albumsTable.id, existingIdsSubquery));

    const deleted = countRows[0]?.count ?? 0;

    await db.delete(albumsTable).where(notInArray(albumsTable.id, existingIdsSubquery));

    return deleted;
  });
}

function cleanupSyncState(
  db: DrizzleDb,
  finishedAt: string,
): Effect.Effect<void, SyncAlbumsDatabaseError> {
  return dbEffect("Finalizing album sync state failed", async () => {
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
  });
}

export async function syncAlbums(db: DrizzleDb, api: SubsonicAPI): Promise<SyncAlbumsResult> {
  const startedAt = new Date().toISOString();

  const program = Effect.gen(function* () {
    yield* dbEffect("Clearing sync album IDs failed", () => db.delete(syncAlbumIdsTable));

    let fetched = 0;
    let inserted = 0;
    let updated = 0;
    let pages = 0;

    for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
      const payload = yield* Effect.retry(
        apiEffect(`Fetching album page failed at offset ${offset}`, () =>
          api.getAlbumList2({
            type: "alphabeticalByArtist",
            size: ALBUM_PAGE_SIZE,
            offset,
          }),
        ),
        { times: 2 },
      );

      const albums = payload.albumList2?.album ?? [];
      const detailedAlbums = yield* fetchAlbumDetails(api, albums);

      pages += 1;
      fetched += albums.length;

      const persisted = yield* persistPage(db, detailedAlbums);
      inserted += persisted.inserted;
      updated += persisted.updated;

      if (albums.length < ALBUM_PAGE_SIZE) {
        break;
      }
    }

    const deleted = yield* deleteMissingAlbums(db);
    const finishedAt = new Date().toISOString();
    yield* cleanupSyncState(db, finishedAt);

    return {
      fetched,
      inserted,
      updated,
      deleted,
      pages,
      startedAt,
      finishedAt,
    };
  });

  return Effect.runPromise(program);
}
