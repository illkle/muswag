import { describe, expect, it } from "vitest";
import { queryOnce } from "@tanstack/db";
import { Layer, ManagedRuntime } from "effect";

import { MuswagDatabase, SyncManager, type MuswagDb } from "@muswag/shared";
import { librarySetA, librarySetB, type AlbumFixture } from "./fixtures/library-sets.js";
import { subsonicLayerFor } from "./helpers/effect-runtime.js";
import { checkNavidromeDependencies, createInMemoryDb, createNavidromeTestConnection, type NavidromeTestConnection } from "./navidrome-testkit.js";

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

function countSongs(albums: readonly AlbumFixture[]): number {
  return albums.reduce((total, album) => total + album.songs.length, 0);
}

async function readLibrary(db: MuswagDb) {
  const albums = await queryOnce((query) => query.from({ albums: db.albums }));
  const songs = await queryOnce((query) => query.from({ songs: db.songs }));
  return { albums, songs };
}

async function withNavidromeLibrary(
  albums: AlbumFixture[],
  run: (context: { db: MuswagDb; connection: NavidromeTestConnection; sync: (mode: "default" | "no_shortcuts") => Promise<null> }) => Promise<void>,
): Promise<void> {
  const connection = await createNavidromeTestConnection(albums, fastLibraryGeneration);
  const db = createInMemoryDb();
  const dependencies = Layer.merge(Layer.succeed(MuswagDatabase, db), subsonicLayerFor(connection));
  const runtime = ManagedRuntime.make(Layer.merge(dependencies, SyncManager.layerWithoutDependencies.pipe(Layer.provide(dependencies))));

  try {
    const manager = runtime.runSync(SyncManager);
    await run({
      db,
      connection,
      sync: (mode) => runtime.runPromise(manager.sync({ mode })),
    });
  } finally {
    await runtime.dispose();
    await connection.cleanup();
  }
}

describeIfReady("navidrome sync integration", () => {
  it("syncs a real Navidrome library into albums and songs", async () => {
    await withNavidromeLibrary(librarySetA, async ({ db, sync }) => {
      await sync("no_shortcuts");

      const state = await readLibrary(db);
      expect(state.albums).toHaveLength(librarySetA.length);
      expect(state.songs).toHaveLength(countSongs(librarySetA));

      const albumIds = new Set(state.albums.map(({ id }) => id));
      expect(state.songs.every(({ albumId }) => albumId !== undefined && albumIds.has(albumId))).toBe(true);
      expect(state.songs.find(({ title }) => title === "Morning Grid")).toMatchObject({
        album: "Sky Patterns",
        artist: "Aurora Lane",
        track: 1,
        genre: "Indie",
        isDir: false,
        suffix: "mp3",
        type: "music",
      });
    });
  });

  it("preserves compilation track artists from real Navidrome metadata", async () => {
    await withNavidromeLibrary(librarySetA, async ({ db, sync }) => {
      await sync("no_shortcuts");

      const { songs } = await readLibrary(db);
      const compilationTracks = songs.filter(({ album }) => album === "Summer Sampler");
      expect(compilationTracks).toHaveLength(2);
      expect(compilationTracks.map(({ artist }) => artist).sort()).toEqual(["June Pixel", "Mira Holt"]);
      expect(compilationTracks.every(({ albumArtists }) => albumArtists?.some(({ name }) => name === "Various Artists"))).toBe(true);
    });
  });

  it("reconciles a real server library replacement", async () => {
    await withNavidromeLibrary(librarySetA, async ({ db, connection, sync }) => {
      await sync("no_shortcuts");
      const before = await readLibrary(db);
      const beforeIds = new Set(before.albums.map(({ id }) => id));

      await connection.replaceLibrary(librarySetB, fastLibraryGeneration);
      await sync("no_shortcuts");

      const after = await readLibrary(db);
      expect(after.albums).toHaveLength(librarySetB.length);
      expect(after.songs).toHaveLength(countSongs(librarySetB));
      expect(after.albums.some(({ id }) => !beforeIds.has(id))).toBe(true);

      const afterAlbumIds = new Set(after.albums.map(({ id }) => id));
      expect(after.songs.every(({ albumId }) => albumId !== undefined && afterAlbumIds.has(albumId))).toBe(true);
    });
  });
});
