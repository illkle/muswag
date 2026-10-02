import { describe, expect, it } from "vitest";
import { Db, LibrarySync } from "@muswag/backend";
import { albums, songs } from "@muswag/model";
import { Effect, Layer, ManagedRuntime } from "effect";

import { librarySetA, librarySetB, type AlbumFixture } from "./fixtures/library-sets.js";
import { createLibrary, subsonicLayerFor, type Library } from "./helpers/effect-runtime.js";
import { checkNavidromeDependencies, createNavidromeTestConnection, type NavidromeTestConnection } from "./navidrome-testkit.js";

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

function readLibrary(db: Library) {
  return db.run(
    Effect.gen(function* () {
      const database = yield* Db;
      return { albums: yield* database.select().from(albums), songs: yield* database.select().from(songs) };
    }),
  );
}

async function withNavidromeLibrary(
  fixtures: AlbumFixture[],
  run: (context: { db: Library; connection: NavidromeTestConnection; sync: (mode: "full" | "quick") => Promise<void> }) => Promise<void>,
): Promise<void> {
  const connection = await createNavidromeTestConnection(fixtures, fastLibraryGeneration);
  const db = createLibrary();
  try {
    await run({
      db,
      connection,
      sync: async (mode) => {
        // Library replacement starts a new container with a new port.
        const runtime = ManagedRuntime.make(LibrarySync.layer.pipe(Layer.provide(Layer.mergeAll(db.layer, subsonicLayerFor(connection)))));
        try {
          await runtime.runPromise(LibrarySync.use((library) => library.sync(mode)));
        } finally {
          await runtime.dispose();
        }
      },
    });
  } finally {
    await db.dispose();
    await connection.cleanup();
  }
}

describeIfReady("navidrome sync integration", () => {
  it("syncs a real Navidrome library into albums and songs", async () => {
    await withNavidromeLibrary(librarySetA, async ({ db, sync }) => {
      await sync("full");

      const state = await readLibrary(db);
      expect(state.albums).toHaveLength(librarySetA.length);
      expect(state.songs).toHaveLength(countSongs(librarySetA));

      const albumIds = new Set(state.albums.map(({ id }) => id));
      expect(state.songs.every(({ albumId }) => albumId !== null && albumIds.has(albumId))).toBe(true);
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
      await sync("full");

      const { songs } = await readLibrary(db);
      const compilationTracks = songs.filter(({ album }) => album === "Summer Sampler");
      expect(compilationTracks).toHaveLength(2);
      expect(compilationTracks.map(({ artist }) => artist).sort()).toEqual(["June Pixel", "Mira Holt"]);
      expect(compilationTracks.every(({ albumArtists }) => albumArtists?.some(({ name }) => name === "Various Artists"))).toBe(true);
    });
  });

  it("reconciles a real server library replacement", async () => {
    await withNavidromeLibrary(librarySetA, async ({ db, connection, sync }) => {
      await sync("full");
      const before = await readLibrary(db);
      const beforeIds = new Set(before.albums.map(({ id }) => id));

      await connection.replaceLibrary(librarySetB, fastLibraryGeneration);
      await sync("full");

      const after = await readLibrary(db);
      expect(after.albums).toHaveLength(librarySetB.length);
      expect(after.songs).toHaveLength(countSongs(librarySetB));
      expect(after.albums.some(({ id }) => !beforeIds.has(id))).toBe(true);

      const afterAlbumIds = new Set(after.albums.map(({ id }) => id));
      expect(after.songs.every(({ albumId }) => albumId !== null && afterAlbumIds.has(albumId))).toBe(true);
    });
  });
});
