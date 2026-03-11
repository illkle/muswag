import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { SyncManager } from "@muswag/db";
import {
  albumArtistRolesTable,
  albumArtistsTable,
  albumDiscTitlesTable,
  albumGenresTable,
  albumMoodsTable,
  albumRecordLabelsTable,
  albumsTable,
  albumReleaseTypesTable,
  type DrizzleDb,
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
} from "@muswag/db";
import { librarySetA, librarySetB } from "./fixtures/library-sets.js";
import {
  checkNavidromeDependencies,
  createInMemoryDrizzleDb,
  withNavidromeLibrary,
} from "./navidrome-testkit.js";

const dependencies = checkNavidromeDependencies();
if (!dependencies.ready) {
  console.warn(
    `Skipping integration tests: ${dependencies.missingDependencies.join(" and ")} unavailable.`,
  );
}
console.info("dependency-check", {
  dockerAvailable: dependencies.dockerAvailable,
  ffmpegAvailable: dependencies.ffmpegAvailable,
});

const describeIfReady = dependencies.ready ? describe : describe.skip;

function countSongsInLibrary(
  albums: ReadonlyArray<{
    songs: ReadonlyArray<unknown>;
  }>,
): number {
  return albums.reduce((count, album) => count + album.songs.length, 0);
}

function buildExpectedTracks(
  albums: typeof librarySetA,
): Array<{
  album: string;
  albumArtist: string;
  albumGenre: string;
  albumComment: string;
  albumYear: number;
  composer: string;
  discNumber: number;
  title: string;
  track: number;
  artist: string;
  musicBrainzTrackId: string;
}> {
  return albums.flatMap((album) =>
    album.songs.map((song) => ({
      album: album.album,
      albumArtist: album.albumArtist,
      albumGenre: album.genre,
      albumComment: album.comment,
      albumYear: album.year,
      composer: album.composer,
      discNumber: album.disc,
      title: song.title,
      track: song.track,
      artist: song.artist ?? album.artist,
      musicBrainzTrackId: song.musicBrainzTrackId,
    })),
  );
}

async function readFullState(db: DrizzleDb) {
  const albums = await db.select().from(albumsTable).orderBy(asc(albumsTable.id));
  const albumRecordLabels = await db
    .select()
    .from(albumRecordLabelsTable)
    .orderBy(asc(albumRecordLabelsTable.albumId), asc(albumRecordLabelsTable.position));
  const albumGenres = await db
    .select()
    .from(albumGenresTable)
    .orderBy(asc(albumGenresTable.albumId), asc(albumGenresTable.position));
  const albumArtists = await db
    .select()
    .from(albumArtistsTable)
    .orderBy(asc(albumArtistsTable.albumId), asc(albumArtistsTable.position));
  const albumArtistRoles = await db
    .select()
    .from(albumArtistRolesTable)
    .orderBy(
      asc(albumArtistRolesTable.albumId),
      asc(albumArtistRolesTable.artistPosition),
      asc(albumArtistRolesTable.position),
    );
  const albumReleaseTypes = await db
    .select()
    .from(albumReleaseTypesTable)
    .orderBy(asc(albumReleaseTypesTable.albumId), asc(albumReleaseTypesTable.position));
  const albumMoods = await db
    .select()
    .from(albumMoodsTable)
    .orderBy(asc(albumMoodsTable.albumId), asc(albumMoodsTable.position));
  const albumDiscTitles = await db
    .select()
    .from(albumDiscTitlesTable)
    .orderBy(asc(albumDiscTitlesTable.albumId), asc(albumDiscTitlesTable.position));
  const songs = await db.select().from(songsTable).orderBy(asc(songsTable.id));
  const songGenres = await db
    .select()
    .from(songGenresTable)
    .orderBy(asc(songGenresTable.songId), asc(songGenresTable.position));
  const songArtists = await db
    .select()
    .from(songArtistsTable)
    .orderBy(asc(songArtistsTable.songId), asc(songArtistsTable.position));
  const songArtistRoles = await db
    .select()
    .from(songArtistRolesTable)
    .orderBy(
      asc(songArtistRolesTable.songId),
      asc(songArtistRolesTable.artistPosition),
      asc(songArtistRolesTable.position),
    );
  const songAlbumArtists = await db
    .select()
    .from(songAlbumArtistsTable)
    .orderBy(asc(songAlbumArtistsTable.songId), asc(songAlbumArtistsTable.position));
  const songAlbumArtistRoles = await db
    .select()
    .from(songAlbumArtistRolesTable)
    .orderBy(
      asc(songAlbumArtistRolesTable.songId),
      asc(songAlbumArtistRolesTable.artistPosition),
      asc(songAlbumArtistRolesTable.position),
    );
  const songContributors = await db
    .select()
    .from(songContributorsTable)
    .orderBy(asc(songContributorsTable.songId), asc(songContributorsTable.position));
  const songMoods = await db
    .select()
    .from(songMoodsTable)
    .orderBy(asc(songMoodsTable.songId), asc(songMoodsTable.position));
  const songReplayGain = await db
    .select()
    .from(songReplayGainTable)
    .orderBy(asc(songReplayGainTable.songId));
  const syncState = await db.select().from(syncStateTable).orderBy(asc(syncStateTable.key));
  const syncAlbumIds = await db.select().from(syncAlbumIdsTable).orderBy(asc(syncAlbumIdsTable.id));

  return {
    albums,
    albumRecordLabels,
    albumGenres,
    albumArtists,
    albumArtistRoles,
    albumReleaseTypes,
    albumMoods,
    albumDiscTitles,
    songs,
    songGenres,
    songArtists,
    songArtistRoles,
    songAlbumArtists,
    songAlbumArtistRoles,
    songContributors,
    songMoods,
    songReplayGain,
    syncState,
    syncAlbumIds,
  };
}

function summarizeState(state: Awaited<ReturnType<typeof readFullState>>) {
  return {
    albums: state.albums.length,
    albumRecordLabels: state.albumRecordLabels.length,
    albumGenres: state.albumGenres.length,
    albumArtists: state.albumArtists.length,
    albumArtistRoles: state.albumArtistRoles.length,
    albumReleaseTypes: state.albumReleaseTypes.length,
    albumMoods: state.albumMoods.length,
    albumDiscTitles: state.albumDiscTitles.length,
    songs: state.songs.length,
    songGenres: state.songGenres.length,
    songArtists: state.songArtists.length,
    songArtistRoles: state.songArtistRoles.length,
    songAlbumArtists: state.songAlbumArtists.length,
    songAlbumArtistRoles: state.songAlbumArtistRoles.length,
    songContributors: state.songContributors.length,
    songMoods: state.songMoods.length,
    songReplayGain: state.songReplayGain.length,
    syncState: state.syncState.length,
    syncAlbumIds: state.syncAlbumIds.length,
  };
}

function assertNoDanglingRelations(state: Awaited<ReturnType<typeof readFullState>>): void {
  const albumIds = new Set(state.albums.map((row) => row.id));
  const songIds = new Set(state.songs.map((row) => row.id));
  const artistKeys = new Set(state.albumArtists.map((row) => `${row.albumId}:${row.position}`));
  const songArtistKeys = new Set(state.songArtists.map((row) => `${row.songId}:${row.position}`));
  const songAlbumArtistKeys = new Set(
    state.songAlbumArtists.map((row) => `${row.songId}:${row.position}`),
  );

  for (const row of state.albumRecordLabels) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumGenres) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumArtists) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumReleaseTypes) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumMoods) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumDiscTitles) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.albumArtistRoles) {
    expect(artistKeys.has(`${row.albumId}:${row.artistPosition}`)).toBe(true);
  }
  for (const row of state.songs) {
    expect(albumIds.has(row.albumId)).toBe(true);
  }
  for (const row of state.songGenres) {
    expect(songIds.has(row.songId)).toBe(true);
  }
  for (const row of state.songArtists) {
    expect(songIds.has(row.songId)).toBe(true);
  }
  for (const row of state.songArtistRoles) {
    expect(songArtistKeys.has(`${row.songId}:${row.artistPosition}`)).toBe(true);
  }
  for (const row of state.songAlbumArtists) {
    expect(songIds.has(row.songId)).toBe(true);
  }
  for (const row of state.songAlbumArtistRoles) {
    expect(songAlbumArtistKeys.has(`${row.songId}:${row.artistPosition}`)).toBe(true);
  }
  for (const row of state.songContributors) {
    expect(songIds.has(row.songId)).toBe(true);
  }
  for (const row of state.songMoods) {
    expect(songIds.has(row.songId)).toBe(true);
  }
  for (const row of state.songReplayGain) {
    expect(songIds.has(row.songId)).toBe(true);
  }
}

async function withTempCoverArtDir(run: (coverArtDir: string) => Promise<void>): Promise<void> {
  const coverArtDir = await mkdtemp(path.join(tmpdir(), "muswag-cover-cache-"));

  try {
    await run(coverArtDir);
  } finally {
    await rm(coverArtDir, { recursive: true, force: true });
  }
}

describeIfReady("navidrome sync integration", () => {
  it("persists detailed track metadata across song-related tables", async () => {
    console.info("test:start", {
      test: "persists detailed track metadata across song-related tables",
    });
    await withTempCoverArtDir(async (coverArtDir) => {
      await withNavidromeLibrary(librarySetA, async (connection) => {
        const drizzleDb = createInMemoryDrizzleDb();
        const consumerDb = new SyncManager(drizzleDb, { coverArtDir });

        await consumerDb.login({
          url: connection.baseUrl,
          username: connection.username,
          password: connection.password,
        });

        const result = await consumerDb.sync();
        expect(result.fetched).toBe(5);

        const state = await readFullState(drizzleDb);
        const albumById = new Map(state.albums.map((album) => [album.id, album]));
        const songsByKey = new Map(
          state.songs.map((song) => [`${song.album}::${song.track ?? -1}::${song.title}`, song]),
        );
        const expectedTracks = buildExpectedTracks(librarySetA);

        expect(state.songs).toHaveLength(expectedTracks.length);
        expect(state.songGenres).toHaveLength(expectedTracks.length);
        expect(state.songArtists).toHaveLength(expectedTracks.length);
        expect(state.songAlbumArtists).toHaveLength(expectedTracks.length);
        expect(state.songContributors).toHaveLength(expectedTracks.length);
        expect(state.songReplayGain).toHaveLength(expectedTracks.length);

        for (const album of state.albums) {
          expect(album.coverArt).toBeTruthy();
          expect(album.coverArtPath).toBeTruthy();
          await expect(access(album.coverArtPath!)).resolves.toBeUndefined();
          const coverBytes = await readFile(album.coverArtPath!);
          expect(coverBytes.byteLength).toBeGreaterThan(0);
        }

        for (const expectedTrack of expectedTracks) {
          const song = songsByKey.get(
            `${expectedTrack.album}::${expectedTrack.track}::${expectedTrack.title}`,
          );

          expect(song).toBeDefined();
          expect(song).toMatchObject({
            album: expectedTrack.album,
            artist: expectedTrack.artist,
            title: expectedTrack.title,
            track: expectedTrack.track,
            discNumber: expectedTrack.discNumber,
            year: expectedTrack.albumYear,
            genre: expectedTrack.albumGenre,
            comment: expectedTrack.albumComment,
            musicBrainzId: expectedTrack.musicBrainzTrackId,
            isDir: false,
            type: "music",
            suffix: "mp3",
          });
          expect(song?.duration).toBeGreaterThan(0);
          expect(song?.contentType).toContain("audio/");

          const album = albumById.get(song!.albumId);
          expect(album).toBeDefined();
          expect(album).toMatchObject({
            name: expectedTrack.album,
          });

          const songGenres = state.songGenres
            .filter((row) => row.songId === song!.id)
            .map((row) => row.value);
          expect(songGenres).toContain(expectedTrack.albumGenre);

          const songArtists = state.songArtists
            .filter((row) => row.songId === song!.id)
            .map((row) => row.name);
          expect(songArtists).toContain(expectedTrack.artist);

          const songAlbumArtists = state.songAlbumArtists
            .filter((row) => row.songId === song!.id)
            .map((row) => row.name);
          expect(songAlbumArtists).toContain(expectedTrack.albumArtist);

          const contributors = state.songContributors.filter((row) => row.songId === song!.id);
          expect(contributors).toHaveLength(1);
          expect(contributors[0]).toMatchObject({
            role: "composer",
            artistName: expectedTrack.composer,
          });

          const replayGainRows = state.songReplayGain.filter((row) => row.songId === song!.id);
          expect(replayGainRows).toHaveLength(1);
          expect(replayGainRows[0]).toMatchObject({
            trackGain: null,
            albumGain: null,
            trackPeak: null,
            albumPeak: null,
            baseGain: null,
            fallbackGain: null,
          });
        }

        const compilationTracks = state.songs.filter((song) => song.album === "Summer Sampler");
        expect(compilationTracks).toHaveLength(2);
        expect(compilationTracks.map((song) => song.artist).sort()).toEqual([
          "June Pixel",
          "Mira Holt",
        ]);
        for (const compilationTrack of compilationTracks) {
          const songAlbumArtists = state.songAlbumArtists
            .filter((row) => row.songId === compilationTrack.id)
            .map((row) => row.name);
          expect(songAlbumArtists).toEqual(["Various Artists"]);
        }
      });
    });
    console.info("test:done", {
      test: "persists detailed track metadata across song-related tables",
    });
  });

  it("syncs albums and remains idempotent across all album-related tables", async () => {
    console.info("test:start", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });
    await withTempCoverArtDir(async (coverArtDir) => {
      await withNavidromeLibrary(librarySetA, async (connection) => {
        const drizzleDb = createInMemoryDrizzleDb();
        const consumerDb = new SyncManager(drizzleDb, { coverArtDir });

        console.info("consumer:login:first", { baseUrl: connection.baseUrl });
        await consumerDb.login({
          url: connection.baseUrl,
          username: connection.username,
          password: connection.password,
        });

        const first = await consumerDb.sync();
        console.info("consumer:sync:first:result", {
          fetched: first.fetched,
          inserted: first.inserted,
          updated: first.updated,
          deleted: first.deleted,
        });
        expect(first.fetched).toBe(5);
        expect(first.inserted).toBe(5);
        expect(first.updated).toBe(0);
        expect(first.deleted).toBe(0);

        const firstState = await readFullState(drizzleDb);
        console.info("state:first:summary", summarizeState(firstState));
        expect(firstState.albums).toHaveLength(5);
        expect(firstState.songs).toHaveLength(countSongsInLibrary(librarySetA));
        expect(firstState.syncAlbumIds).toHaveLength(0);
        assertNoDanglingRelations(firstState);

        const firstCoverSnapshots = await Promise.all(
          firstState.albums.map(async (album) => ({
            id: album.id,
            coverArtPath: album.coverArtPath,
            coverBytes: await readFile(album.coverArtPath!),
          })),
        );

        const firstSyncState = firstState.syncState.find(
          (row) => row.key === "albums_last_synced_at",
        );
        expect(firstSyncState).toBeDefined();
        expect(firstSyncState?.value.length).toBeGreaterThan(0);

        const second = await consumerDb.sync();
        console.info("consumer:sync:second:result", {
          fetched: second.fetched,
          inserted: second.inserted,
          updated: second.updated,
          deleted: second.deleted,
        });
        expect(second.fetched).toBe(5);
        expect(second.inserted).toBe(0);
        expect(second.updated).toBe(5);
        expect(second.deleted).toBe(0);

        const secondState = await readFullState(drizzleDb);
        console.info("state:second:summary", summarizeState(secondState));
        expect(secondState.syncAlbumIds).toHaveLength(0);
        assertNoDanglingRelations(secondState);

        expect(secondState.albums).toEqual(firstState.albums);
        expect(secondState.albumRecordLabels).toEqual(firstState.albumRecordLabels);
        expect(secondState.albumGenres).toEqual(firstState.albumGenres);
        expect(secondState.albumArtists).toEqual(firstState.albumArtists);
        expect(secondState.albumArtistRoles).toEqual(firstState.albumArtistRoles);
        expect(secondState.albumReleaseTypes).toEqual(firstState.albumReleaseTypes);
        expect(secondState.albumMoods).toEqual(firstState.albumMoods);
        expect(secondState.albumDiscTitles).toEqual(firstState.albumDiscTitles);
        expect(secondState.songs).toEqual(firstState.songs);
        expect(secondState.songGenres).toEqual(firstState.songGenres);
        expect(secondState.songArtists).toEqual(firstState.songArtists);
        expect(secondState.songArtistRoles).toEqual(firstState.songArtistRoles);
        expect(secondState.songAlbumArtists).toEqual(firstState.songAlbumArtists);
        expect(secondState.songAlbumArtistRoles).toEqual(firstState.songAlbumArtistRoles);
        expect(secondState.songContributors).toEqual(firstState.songContributors);
        expect(secondState.songMoods).toEqual(firstState.songMoods);
        expect(secondState.songReplayGain).toEqual(firstState.songReplayGain);

        await Promise.all(
          firstCoverSnapshots.map(async ({ id, coverArtPath, coverBytes }) => {
            const secondAlbum = secondState.albums.find((album) => album.id === id);
            expect(secondAlbum?.coverArtPath).toBe(coverArtPath);
            const currentBytes = await readFile(secondAlbum!.coverArtPath!);
            expect(currentBytes.equals(coverBytes)).toBe(true);
          }),
        );

        const secondSyncState = secondState.syncState.find(
          (row) => row.key === "albums_last_synced_at",
        );
        expect(secondSyncState).toBeDefined();
        expect(secondSyncState?.value).not.toBe(firstSyncState?.value);
      });
    });
    console.info("test:done", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });
  });

  it("reconciles album deletions when server library changes", async () => {
    console.info("test:start", {
      test: "reconciles album deletions when server library changes",
    });
    const drizzleDb = createInMemoryDrizzleDb();
    await withTempCoverArtDir(async (coverArtDir) => {
      const consumerDb = new SyncManager(drizzleDb, { coverArtDir });

      await withNavidromeLibrary(librarySetA, async (connectionA) => {
        console.info("consumer:login:library-a", { baseUrl: connectionA.baseUrl });
        await consumerDb.login({
          url: connectionA.baseUrl,
          username: connectionA.username,
          password: connectionA.password,
        });
        const resultA = await consumerDb.sync();
        console.info("consumer:sync:library-a:result", {
          fetched: resultA.fetched,
          inserted: resultA.inserted,
          updated: resultA.updated,
          deleted: resultA.deleted,
        });
        expect(resultA.fetched).toBe(5);
        expect(resultA.deleted).toBe(0);
      });

      const beforeState = await readFullState(drizzleDb);
      console.info("state:before:summary", summarizeState(beforeState));
      const beforeIds = new Set(beforeState.albums.map((album) => album.id));
      const removedAlbumCoverPaths = new Map(
        beforeState.albums.map((album) => [album.id, album.coverArtPath]),
      );

      await withNavidromeLibrary(librarySetB, async (connectionB) => {
        console.info("consumer:login:library-b", { baseUrl: connectionB.baseUrl });
        await consumerDb.login({
          url: connectionB.baseUrl,
          username: connectionB.username,
          password: connectionB.password,
        });
        const resultB = await consumerDb.sync();
        console.info("consumer:sync:library-b:result", {
          fetched: resultB.fetched,
          inserted: resultB.inserted,
          updated: resultB.updated,
          deleted: resultB.deleted,
        });
        expect(resultB.fetched).toBe(5);
        expect(resultB.deleted).toBeGreaterThan(0);
      });

      const afterState = await readFullState(drizzleDb);
      console.info("state:after:summary", summarizeState(afterState));
      const afterIds = new Set(afterState.albums.map((album) => album.id));

      expect(afterState.albums).toHaveLength(5);
      expect(afterState.songs).toHaveLength(countSongsInLibrary(librarySetB));
      expect(afterState.syncAlbumIds).toHaveLength(0);
      assertNoDanglingRelations(afterState);

      const hasNewAlbumIds = [...afterIds].some((id) => !beforeIds.has(id));
      expect(hasNewAlbumIds).toBe(true);

      for (const beforeAlbum of beforeState.albums) {
        const stillExists = afterState.albums.some((album) => album.id === beforeAlbum.id);
        if (stillExists) {
          continue;
        }

        const removedCoverArtPath = removedAlbumCoverPaths.get(beforeAlbum.id);
        expect(removedCoverArtPath).toBeTruthy();
        await expect(access(removedCoverArtPath!)).rejects.toThrow();

        const childLabels = afterState.albumRecordLabels.filter(
          (row) => row.albumId === beforeAlbum.id,
        );
        const childGenres = afterState.albumGenres.filter((row) => row.albumId === beforeAlbum.id);
        const childArtists = afterState.albumArtists.filter((row) => row.albumId === beforeAlbum.id);
        const childRoles = afterState.albumArtistRoles.filter(
          (row) => row.albumId === beforeAlbum.id,
        );
        const childReleaseTypes = afterState.albumReleaseTypes.filter(
          (row) => row.albumId === beforeAlbum.id,
        );
        const childMoods = afterState.albumMoods.filter((row) => row.albumId === beforeAlbum.id);
        const childDiscTitles = afterState.albumDiscTitles.filter(
          (row) => row.albumId === beforeAlbum.id,
        );
        const childSongs = afterState.songs.filter((row) => row.albumId === beforeAlbum.id);
        const removedSongIds = beforeState.songs
          .filter((row) => row.albumId === beforeAlbum.id)
          .map((row) => row.id);
        const childSongGenres = afterState.songGenres.filter((row) => removedSongIds.includes(row.songId));
        const childSongArtists = afterState.songArtists.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongArtistRoles = afterState.songArtistRoles.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongAlbumArtists = afterState.songAlbumArtists.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongAlbumArtistRoles = afterState.songAlbumArtistRoles.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongContributors = afterState.songContributors.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongMoods = afterState.songMoods.filter((row) =>
          removedSongIds.includes(row.songId),
        );
        const childSongReplayGain = afterState.songReplayGain.filter((row) =>
          removedSongIds.includes(row.songId),
        );

        expect(childLabels).toHaveLength(0);
        expect(childGenres).toHaveLength(0);
        expect(childArtists).toHaveLength(0);
        expect(childRoles).toHaveLength(0);
        expect(childReleaseTypes).toHaveLength(0);
        expect(childMoods).toHaveLength(0);
        expect(childDiscTitles).toHaveLength(0);
        expect(childSongs).toHaveLength(0);
        expect(childSongGenres).toHaveLength(0);
        expect(childSongArtists).toHaveLength(0);
        expect(childSongArtistRoles).toHaveLength(0);
        expect(childSongAlbumArtists).toHaveLength(0);
        expect(childSongAlbumArtistRoles).toHaveLength(0);
        expect(childSongContributors).toHaveLength(0);
        expect(childSongMoods).toHaveLength(0);
        expect(childSongReplayGain).toHaveLength(0);
      }

      const syncStateRow = await drizzleDb
        .select()
        .from(syncStateTable)
        .where(eq(syncStateTable.key, "albums_last_synced_at"))
        .limit(1);
      expect(syncStateRow).toHaveLength(1);
      console.info("test:done", {
        test: "reconciles album deletions when server library changes",
      });
    });
  });
});
