import { access, readFile } from "node:fs/promises";
import { describe } from "node:test";

import { expect, it } from "vitest";

import type { Album, MuswagDb, Song } from "@muswag/shared";
import { createCoverArtStore, getUserInfo, login, stripVirtualProps, sync } from "@muswag/shared";
import { librarySetA, librarySetB } from "./fixtures/library-sets.js";
import {
  createInMemoryDb,
  createNavidromeTestConnection,
  createTempCoverArtDir,
  type NavidromeTestConnection,
  type TempDir,
} from "./navidrome-testkit.js";

function countSongsInLibrary(
  albums: ReadonlyArray<{
    songs: ReadonlyArray<unknown>;
  }>,
): number {
  return albums.reduce((count, album) => count + album.songs.length, 0);
}

function buildExpectedTracks(albums: typeof librarySetA): Array<{
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

function readFullState(db: MuswagDb) {
  const albums: Album[] = [];
  for (const [, album] of db.albums.entries()) {
    albums.push(stripVirtualProps(album) as Album);
  }
  albums.sort((a, b) => a.id.localeCompare(b.id));

  const songs: Song[] = [];
  for (const [, song] of db.songs.entries()) {
    songs.push(stripVirtualProps(song) as Song);
  }
  songs.sort((a, b) => a.id.localeCompare(b.id));

  return { albums, songs };
}

function assertNoDanglingRelations(state: ReturnType<typeof readFullState>): void {
  const albumIds = new Set(state.albums.map((album) => album.id));
  for (const song of state.songs) {
    expect(albumIds.has(song.albumId)).toBe(true);
  }
}

function coverArtStoreFor(connection: { baseUrl: string; username: string; password: string }, coverArtDir: string) {
  return createCoverArtStore({ url: connection.baseUrl, username: connection.username, password: connection.password, coverArtDir });
}

describe("navidrome sync integration", () => {
  it("persists detailed track metadata across song-related tables", async () => {
    console.info("test:start", {
      test: "persists detailed track metadata across song-related tables",
    });

    let coverArt: TempDir | undefined;
    let connection: NavidromeTestConnection | undefined;

    try {
      coverArt = await createTempCoverArtDir();
      connection = await createNavidromeTestConnection(librarySetA);

      const db = createInMemoryDb();

      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });

      const result = await sync(db, coverArtStoreFor(connection, coverArt.path));
      expect(result.lastStatus).toBe("completed");

      const state = readFullState(db);
      const albumById = new Map(state.albums.map((album) => [album.id, album]));
      const songsByKey = new Map(state.songs.map((song) => [`${song.album}::${song.track ?? -1}::${song.title}`, song]));
      const expectedTracks = buildExpectedTracks(librarySetA);

      expect(state.songs).toHaveLength(expectedTracks.length);

      // Verify each song has genre, artist, album artist, contributor, and replay gain data
      for (const song of state.songs) {
        expect(song.genres.length).toBeGreaterThanOrEqual(1);
        expect(song.artists.length).toBeGreaterThanOrEqual(1);
        expect(song.albumArtists.length).toBeGreaterThanOrEqual(1);
        expect(song.contributors.length).toBeGreaterThanOrEqual(1);
        expect(song.replayGain).toBeDefined();
      }

      for (const album of state.albums) {
        expect(album.coverArt).toBeTruthy();
        expect(album.coverArtPath).toBeTruthy();
        await expect(access(album.coverArtPath!)).resolves.toBeUndefined();
        const coverBytes = await readFile(album.coverArtPath!);
        expect(coverBytes.byteLength).toBeGreaterThan(0);
      }

      for (const expectedTrack of expectedTracks) {
        const song = songsByKey.get(`${expectedTrack.album}::${expectedTrack.track}::${expectedTrack.title}`);

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

        const songGenres = song!.genres.map((g) => g.value);
        expect(songGenres).toContain(expectedTrack.albumGenre);

        const songArtists = song!.artists.map((a) => a.name);
        expect(songArtists).toContain(expectedTrack.artist);

        const songAlbumArtists = song!.albumArtists.map((a) => a.name);
        expect(songAlbumArtists).toContain(expectedTrack.albumArtist);

        const contributors = song!.contributors;
        expect(contributors).toHaveLength(1);
        expect(contributors[0]).toMatchObject({
          role: "composer",
          artistName: expectedTrack.composer,
        });

        expect(song!.replayGain).toMatchObject({
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
      expect(compilationTracks.map((song) => song.artist).sort()).toEqual(["June Pixel", "Mira Holt"]);
      for (const compilationTrack of compilationTracks) {
        const songAlbumArtists = compilationTrack.albumArtists.map((a) => a.name);
        expect(songAlbumArtists).toEqual(["Various Artists"]);
      }
    } finally {
      await connection?.cleanup();
      await coverArt?.cleanup();
    }

    console.info("test:done", {
      test: "persists detailed track metadata across song-related tables",
    });
  });

  it("syncs albums and remains idempotent across all album-related tables", async () => {
    console.info("test:start", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });

    let coverArt: TempDir | undefined;
    let connection: NavidromeTestConnection | undefined;

    try {
      coverArt = await createTempCoverArtDir();
      connection = await createNavidromeTestConnection(librarySetA);

      const db = createInMemoryDb();

      console.info("consumer:login:first", { baseUrl: connection.baseUrl });
      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });

      const first = await sync(db, coverArtStoreFor(connection, coverArt.path));
      console.info("consumer:sync:first:result", {
        status: first.lastStatus,
      });
      expect(first.lastStatus).toBe("completed");

      const firstState = readFullState(db);
      expect(firstState.albums).toHaveLength(5);
      expect(firstState.songs).toHaveLength(countSongsInLibrary(librarySetA));
      assertNoDanglingRelations(firstState);

      const firstCoverSnapshots = await Promise.all(
        firstState.albums.map(async (album) => ({
          id: album.id,
          coverArtPath: album.coverArtPath,
          coverBytes: await readFile(album.coverArtPath!),
        })),
      );

      const u = getUserInfo(db);
      expect(u).toBeTruthy();

      const second = await sync(db, coverArtStoreFor(connection, coverArt.path));
      console.info("consumer:sync:second:result", {
        status: second.lastStatus,
      });
      expect(second.lastStatus).toBe("completed");

      const secondState = readFullState(db);
      assertNoDanglingRelations(secondState);

      // Verify idempotency: all albums and songs should be structurally identical
      expect(secondState.albums).toHaveLength(firstState.albums.length);
      expect(secondState.songs).toHaveLength(firstState.songs.length);

      for (const firstAlbum of firstState.albums) {
        const secondAlbum = secondState.albums.find((a) => a.id === firstAlbum.id);
        expect(secondAlbum).toBeDefined();
        expect(secondAlbum).toEqual(firstAlbum);
      }

      for (const firstSong of firstState.songs) {
        const secondSong = secondState.songs.find((s) => s.id === firstSong.id);
        expect(secondSong).toBeDefined();
        expect(secondSong).toEqual(firstSong);
      }

      await Promise.all(
        firstCoverSnapshots.map(async ({ id, coverArtPath, coverBytes }) => {
          const secondAlbum = secondState.albums.find((album) => album.id === id);
          expect(secondAlbum?.coverArtPath).toBe(coverArtPath);
          const currentBytes = await readFile(secondAlbum!.coverArtPath!);
          expect(currentBytes.equals(coverBytes)).toBe(true);
        }),
      );

      const u2 = getUserInfo(db);
      expect(u2).toBeTruthy();
    } finally {
      await connection?.cleanup();
      await coverArt?.cleanup();
    }

    console.info("test:done", {
      test: "syncs albums and remains idempotent across all album-related tables",
    });
  });

  it("reconciles album deletions when server library changes", async () => {
    console.info("test:start", {
      test: "reconciles album deletions when server library changes",
    });

    let coverArt: TempDir | undefined;
    let connection: NavidromeTestConnection | undefined;

    try {
      coverArt = await createTempCoverArtDir();
      connection = await createNavidromeTestConnection(librarySetA);

      const db = createInMemoryDb();

      console.info("consumer:login:library-a", { baseUrl: connection.baseUrl });
      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });
      const resultA = await sync(db, coverArtStoreFor(connection, coverArt.path));
      console.info("consumer:sync:library-a:result", {
        status: resultA.lastStatus,
      });
      expect(resultA.lastStatus).toBe("completed");

      const beforeState = readFullState(db);
      const beforeIds = new Set(beforeState.albums.map((album) => album.id));
      const removedAlbumCoverPaths = new Map(beforeState.albums.map((album) => [album.id, album.coverArtPath]));

      // Swap the server library to a different set of albums
      await connection.replaceLibrary(librarySetB);

      console.info("consumer:login:library-b", { baseUrl: connection.baseUrl });
      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });
      const resultB = await sync(db, coverArtStoreFor(connection, coverArt.path));
      console.info("consumer:sync:library-b:result", {
        status: resultB.lastStatus,
      });
      expect(resultB.lastStatus).toBe("completed");

      const afterState = readFullState(db);
      const afterIds = new Set(afterState.albums.map((album) => album.id));

      expect(afterState.albums).toHaveLength(5);
      expect(afterState.songs).toHaveLength(countSongsInLibrary(librarySetB));
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

        // Verify all songs for this album were deleted
        const orphanedSongs = afterState.songs.filter((song) => song.albumId === beforeAlbum.id);
        expect(orphanedSongs).toHaveLength(0);
      }

      const u = getUserInfo(db);
      expect(u).toBeTruthy();
    } finally {
      await connection?.cleanup();
      await coverArt?.cleanup();
    }

    console.info("test:done", {
      test: "reconciles album deletions when server library changes",
    });
  });
});
