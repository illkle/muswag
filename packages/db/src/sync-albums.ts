import { eq, notInArray, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import SubsonicAPI from "subsonic-api";
import { z } from "zod";

import {
  albumArtistRolesTable,
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumsTable,
  albumReleaseTypesTable,
  DrizzleDb,
  syncAlbumIdsTable,
  syncStateTable,
} from "./drizzle/schema.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUMS_LAST_SYNCED_AT_KEY = "albums_last_synced_at";

const itemDateSchema = z
  .object({
    year: z.number().int().optional(),
    month: z.number().int().optional(),
    day: z.number().int().optional(),
  })
  .strict();

const recordLabelSchema = z
  .object({
    name: z.string(),
  })
  .strict();

const itemGenreSchema = z
  .object({
    name: z.string(),
  })
  .strict();

const albumArtistSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    coverArt: z.string().optional(),
    artistImageUrl: z.string().optional(),
    albumCount: z.number().int().optional(),
    starred: z.string().optional(),
    musicBrainzId: z.string().optional(),
    sortName: z.string().optional(),
    roles: z.array(z.string()).optional(),
  })
  .strict();

const discTitleSchema = z
  .object({
    disc: z.number().int(),
    title: z.string(),
  })
  .strict();

const albumSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string().optional(),
    artist: z.string().optional(),
    artistId: z.string().optional(),
    coverArt: z.string().optional(),
    songCount: z.number().int(),
    duration: z.number().int(),
    playCount: z.number().int().optional(),
    created: z.string(),
    starred: z.string().optional(),
    year: z.number().int().optional(),
    genre: z.string().optional(),
    played: z.string().optional(),
    userRating: z.number().int().optional(),
    recordLabels: z.array(recordLabelSchema).optional(),
    musicBrainzId: z.string().optional(),
    genres: z.array(itemGenreSchema).optional(),
    artists: z.array(albumArtistSchema).optional(),
    displayArtist: z.string().optional(),
    releaseTypes: z.array(z.string()).optional(),
    moods: z.array(z.string()).optional(),
    sortName: z.string().optional(),
    originalReleaseDate: itemDateSchema.optional(),
    releaseDate: itemDateSchema.optional(),
    isCompilation: z.boolean().optional(),
    explicitStatus: z.string().optional(),
    discTitles: z.array(discTitleSchema).optional(),
  })
  .strict();

const albumList2PageSchema = z
  .object({
    albumList2: z
      .object({
        album: z.array(albumSchema).optional(),
      })
      .optional(),
  })
  .passthrough();

type Album = z.infer<typeof albumSchema>;
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

export class SyncAlbumsValidationError extends Data.TaggedError("SyncAlbumsValidationError")<{
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

function parseAlbumPage(
  payload: unknown,
  offset: number,
): Effect.Effect<Album[], SyncAlbumsValidationError> {
  return Effect.try({
    try: () => albumList2PageSchema.parse(payload).albumList2?.album ?? [],
    catch: (cause) =>
      new SyncAlbumsValidationError({
        message: `Album page response validation failed at offset ${offset}`,
        cause,
      }),
  });
}

async function persistAlbumRows(tx: SyncTransaction, album: Album): Promise<void> {
  await tx.delete(albumRecordLabelsTable).where(eq(albumRecordLabelsTable.albumId, album.id));
  await tx.delete(albumGenresTable).where(eq(albumGenresTable.albumId, album.id));
  await tx.delete(albumArtistRolesTable).where(eq(albumArtistRolesTable.albumId, album.id));
  await tx.delete(albumArtistsTable).where(eq(albumArtistsTable.albumId, album.id));
  await tx.delete(albumReleaseTypesTable).where(eq(albumReleaseTypesTable.albumId, album.id));
  await tx.delete(albumMoodsTable).where(eq(albumMoodsTable.albumId, album.id));
  await tx.delete(albumDiscTitlesTable).where(eq(albumDiscTitlesTable.albumId, album.id));

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
      genres.map((item, position) => ({
        albumId: album.id,
        position,
        name: item.name,
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

function persistPage(
  db: DrizzleDb,
  albums: Album[],
): Effect.Effect<{ inserted: number; updated: number }, SyncAlbumsDatabaseError> {
  return dbEffect("Persisting album page failed", async () => {
    let inserted = 0;
    let updated = 0;

    await db.transaction(async (tx) => {
      for (const album of albums) {
        const existing = await tx
          .select({ id: albumsTable.id })
          .from(albumsTable)
          .where(eq(albumsTable.id, album.id))
          .limit(1);

        if (existing.length > 0) {
          updated += 1;
        } else {
          inserted += 1;
        }

        await tx
          .insert(albumsTable)
          .values({
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
          })
          .onConflictDoUpdate({
            target: albumsTable.id,
            set: {
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
            },
          });

        await tx.insert(syncAlbumIdsTable).values({ id: album.id }).onConflictDoNothing();
        await persistAlbumRows(tx, album);
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

      const albums = yield* parseAlbumPage(payload.albumList2, offset);

      pages += 1;
      fetched += albums.length;

      const persisted = yield* persistPage(db, albums);
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
