import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { albumsTable, songsTable, SyncManager } from "@muswag/db";
import {
  buildSyncBenchmarkLibrary,
  SYNC_BENCHMARK_ALBUM_COUNT,
  SYNC_BENCHMARK_ARTIST_COUNT,
  SYNC_BENCHMARK_SONG_COUNT,
} from "./fixtures/library-sets.js";
import {
  checkNavidromeDependencies,
  createInMemoryDrizzleDb,
  withNavidromeLibrary,
} from "./navidrome-testkit.js";

const dependencies = checkNavidromeDependencies();
const benchmarkEnabled = process.env.MUSWAG_RUN_SYNC_BENCHMARK === "1";
const describeBenchmark = dependencies.ready && benchmarkEnabled ? describe : describe.skip;

describeBenchmark("navidrome sync benchmark", () => {
  it(
    "syncs a 10k song library and prints the sync duration",
    async () => {
      const benchmarkLibrary = buildSyncBenchmarkLibrary();
      expect(benchmarkLibrary).toHaveLength(SYNC_BENCHMARK_ALBUM_COUNT);
      expect(new Set(benchmarkLibrary.map((album) => album.artist)).size).toBe(
        SYNC_BENCHMARK_ARTIST_COUNT,
      );

      await withNavidromeLibrary(
        benchmarkLibrary,
        async (connection) => {
          const benchmarkDb = new SyncManager(createInMemoryDrizzleDb());
          await benchmarkDb.login({
            url: connection.baseUrl,
            username: connection.username,
            password: connection.password,
          });

          let result: Awaited<ReturnType<typeof benchmarkDb.sync>>;
          const syncStartedAt = performance.now();
          try {
            result = await benchmarkDb.sync();
          } catch (error) {
            console.error("benchmark:sync:failed", error);
            console.error("benchmark:sync:failed:cause", error instanceof Error ? error.cause : error);
            throw error;
          }
          const syncDurationMs = performance.now() - syncStartedAt;

          const syncedAlbums = await benchmarkDb.db.select({ id: albumsTable.id }).from(albumsTable);
          const syncedSongs = await benchmarkDb.db.select({ id: songsTable.id }).from(songsTable);

          console.info("benchmark:sync", {
            albumCount: benchmarkLibrary.length,
            uniqueArtistCount: SYNC_BENCHMARK_ARTIST_COUNT,
            songCount: SYNC_BENCHMARK_SONG_COUNT,
            fetched: result.fetched,
            inserted: result.inserted,
            updated: result.updated,
            deleted: result.deleted,
            pages: result.pages,
            durationMs: Number(syncDurationMs.toFixed(2)),
          });

          expect(result.fetched).toBe(SYNC_BENCHMARK_ALBUM_COUNT);
          expect(syncedAlbums).toHaveLength(SYNC_BENCHMARK_ALBUM_COUNT);
          expect(syncedSongs).toHaveLength(SYNC_BENCHMARK_SONG_COUNT);
        },
        {
          scanTimeoutMs: 600_000,
          generation: {
            mode: "tagged-template",
            logPerAlbum: false,
            logPerTrack: false,
          },
        },
      );
    },
    900_000,
  );
});
