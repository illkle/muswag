import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { MuswagDb, SyncRecord } from "@muswag/shared";
import { login, sync } from "@muswag/shared";
import { librarySetA, librarySetB, type AlbumFixture } from "./fixtures/library-sets.js";
import {
  assertNoDanglingRelations,
  countSongsInLibrary,
  coverArtStoreFor,
  expectSongMetadata,
  expectSyncedCounts,
  readFullState,
} from "./helpers/sync-testkit.js";
import {
  checkNavidromeDependencies,
  createInMemoryDb,
  createNavidromeTestConnection,
  createTempCoverArtDir,
  type NavidromeTestConnection,
  type TempDir,
} from "./navidrome-testkit.js";

const dependencyStatus = checkNavidromeDependencies();
const describeIfReady = dependencyStatus.ready ? describe : describe.skip;
const fastLibraryGeneration = {
  generation: {
    mode: "tagged-template" as const,
    logPerTrack: false,
    logPerAlbum: false,
  },
};

if (!dependencyStatus.ready) {
  console.warn("Skipping Navidrome integration tests; missing dependencies.", {
    missingDependencies: dependencyStatus.missingDependencies,
  });
}

async function withSyncedNavidromeLibrary<T>(
  albums: AlbumFixture[],
  run: (ctx: {
    db: MuswagDb;
    connection: NavidromeTestConnection;
    coverArt: TempDir;
    syncOnce: () => Promise<SyncRecord>;
    readState: () => ReturnType<typeof readFullState>;
  }) => Promise<T>,
): Promise<T> {
  let coverArt: TempDir | undefined;
  let connection: NavidromeTestConnection | undefined;

  try {
    coverArt = await createTempCoverArtDir();
    connection = await createNavidromeTestConnection(albums, fastLibraryGeneration);

    const db = createInMemoryDb();
    await login(db, {
      url: connection.baseUrl,
      username: connection.username,
      password: connection.password,
    });

    return await run({
      db,
      connection,
      coverArt,
      syncOnce: () => sync(db, coverArtStoreFor(connection!, coverArt!.path)),
      readState: () => readFullState(db),
    });
  } finally {
    await connection?.cleanup();
    await coverArt?.cleanup();
  }
}

describeIfReady("navidrome sync integration", () => {
  it("syncs a real Navidrome library into albums and songs", async () => {
    await withSyncedNavidromeLibrary(librarySetA, async ({ syncOnce, readState }) => {
      const result = await syncOnce();
      expect(result.lastStatus).toBe("completed");

      const state = await readState();
      expectSyncedCounts(state, {
        albums: librarySetA.length,
        songs: countSongsInLibrary(librarySetA),
      });
      assertNoDanglingRelations(state);

      const representativeSong = state.songs.find((song) => song.title === "Morning Grid");
      expectSongMetadata(representativeSong, {
        album: "Sky Patterns",
        title: "Morning Grid",
        artist: "Aurora Lane",
        albumArtist: "Aurora Lane",
      });
      expect(representativeSong).toMatchObject({
        track: 1,
        genre: "Indie",
        isDir: false,
        suffix: "mp3",
        type: "music",
      });
      expect(representativeSong?.contentType).toContain("audio/");

      const albumWithCover = state.albums.find((album) => album.name === "Sky Patterns");
      expect(albumWithCover?.coverArtPath).toBeTruthy();
      await expect(access(albumWithCover!.coverArtPath!)).resolves.toBeUndefined();
      const coverBytes = await readFile(albumWithCover!.coverArtPath!);
      expect(coverBytes.byteLength).toBeGreaterThan(0);
    });
  });

  it("preserves compilation track artists from real Navidrome metadata", async () => {
    await withSyncedNavidromeLibrary(librarySetA, async ({ syncOnce, readState }) => {
      const result = await syncOnce();
      expect(result.lastStatus).toBe("completed");

      const state = await readState();
      const compilationTracks = state.songs.filter((song) => song.album === "Summer Sampler");

      expect(compilationTracks).toHaveLength(2);
      expect(compilationTracks.map((song) => song.artist).sort()).toEqual(["June Pixel", "Mira Holt"]);
      for (const track of compilationTracks) {
        expectSongMetadata(track, {
          album: "Summer Sampler",
          title: track.title,
          artist: track.artist ?? "",
          albumArtist: "Various Artists",
        });
      }
    });
  });

  it("reconciles a real server library replacement", async () => {
    await withSyncedNavidromeLibrary(librarySetA, async ({ db, connection, coverArt, syncOnce, readState }) => {
      const resultA = await syncOnce();
      expect(resultA.lastStatus).toBe("completed");

      const beforeState = await readState();
      const beforeIds = new Set(beforeState.albums.map((album) => album.id));
      const removedAlbumCoverPaths = new Map(beforeState.albums.map((album) => [album.id, album.coverArtPath]));

      await connection.replaceLibrary(librarySetB, fastLibraryGeneration);
      await login(db, {
        url: connection.baseUrl,
        username: connection.username,
        password: connection.password,
      });

      const resultB = await sync(db, coverArtStoreFor(connection, coverArt.path));
      expect(resultB.lastStatus).toBe("completed");

      const afterState = await readState();
      const afterIds = new Set(afterState.albums.map((album) => album.id));

      expectSyncedCounts(afterState, {
        albums: librarySetB.length,
        songs: countSongsInLibrary(librarySetB),
      });
      assertNoDanglingRelations(afterState);
      expect([...afterIds].some((id) => !beforeIds.has(id))).toBe(true);

      for (const beforeAlbum of beforeState.albums) {
        const stillExists = afterState.albums.some((album) => album.id === beforeAlbum.id);
        if (stillExists) {
          continue;
        }

        const removedCoverArtPath = removedAlbumCoverPaths.get(beforeAlbum.id);
        expect(removedCoverArtPath).toBeTruthy();
        await expect(access(removedCoverArtPath!)).rejects.toThrow();
        expect(afterState.songs.some((song) => song.albumId === beforeAlbum.id)).toBe(false);
      }
    });
  });
});
