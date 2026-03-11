import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3-test";
import { describe, expect, it } from "vitest";

import { albumsTable, createDrizzleDb, migrateDb, songsTable, SyncManager } from "@muswag/db";
import {
  buildSyncBenchmarkLibrary,
  SYNC_BENCHMARK_ALBUM_COUNT,
  SYNC_BENCHMARK_ARTIST_COUNT,
  SYNC_BENCHMARK_SONG_COUNT,
} from "./fixtures/library-sets.js";
import {
  checkNavidromeDependencies,
  withNavidromeLibrary,
} from "./navidrome-testkit.js";

const dependencies = checkNavidromeDependencies();
const benchmarkEnabled = process.env.MUSWAG_RUN_SYNC_BENCHMARK === "1";
const describeBenchmark = dependencies.ready && benchmarkEnabled ? describe : describe.skip;

interface FetchProfiler {
  byAddress: Map<string, { requestCount: number; totalTimeMs: number }>;
  requestCount: number;
  totalTimeMs: number;
}

function createFetchProfiler(): FetchProfiler {
  return {
    byAddress: new Map(),
    requestCount: 0,
    totalTimeMs: 0,
  };
}

function normalizeFetchAddress(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return new URL(input).pathname;
  }

  if (input instanceof URL) {
    return input.pathname;
  }

  return new URL(input.url).pathname;
}

async function withProfiledFetch<T>(
  profiler: FetchProfiler,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const address = normalizeFetchAddress(args[0]);
    const startedAt = performance.now();
    try {
      return await originalFetch(...args);
    } finally {
      const durationMs = performance.now() - startedAt;
      profiler.requestCount += 1;
      profiler.totalTimeMs += durationMs;
      const existing = profiler.byAddress.get(address) ?? {
        requestCount: 0,
        totalTimeMs: 0,
      };
      existing.requestCount += 1;
      existing.totalTimeMs += durationMs;
      profiler.byAddress.set(address, existing);
    }
  };

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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
          const sqlite = new BetterSqlite3(":memory:");
          sqlite.pragma("foreign_keys = ON");
          const coverArtDir = await mkdtemp(path.join(tmpdir(), "muswag-benchmark-cover-cache-"));

          const drizzleDb = createDrizzleDb(sqlite);
          migrateDb(drizzleDb);

          const benchmarkDb = new SyncManager(drizzleDb, { coverArtDir });
          try {
            await benchmarkDb.login({
              url: connection.baseUrl,
              username: connection.username,
              password: connection.password,
            });

            const fetchProfiler = createFetchProfiler();
            let result: Awaited<ReturnType<typeof benchmarkDb.sync>>;
            const syncStartedAt = performance.now();
            try {
              result = await withProfiledFetch(fetchProfiler, () => benchmarkDb.sync());
            } catch (error) {
              console.error("benchmark:sync:failed", error);
              console.error(
                "benchmark:sync:failed:cause",
                error instanceof Error ? error.cause : error,
              );
              throw error;
            }
            const syncDurationMs = performance.now() - syncStartedAt;
            const httpTimeByAddress = [...fetchProfiler.byAddress.entries()]
              .map(([address, metrics]) => ({
                address,
                requestCount: metrics.requestCount,
                timeMs: Number(metrics.totalTimeMs.toFixed(2)),
              }))
              .sort((left, right) => right.timeMs - left.timeMs);
            const benchmarkStats = {
              albumCount: benchmarkLibrary.length,
              uniqueArtistCount: SYNC_BENCHMARK_ARTIST_COUNT,
              songCount: SYNC_BENCHMARK_SONG_COUNT,
              fetched: result.fetched,
              inserted: result.inserted,
              updated: result.updated,
              deleted: result.deleted,
              pages: result.pages,
              durationMs: Number(syncDurationMs.toFixed(2)),
              httpRequestCount: fetchProfiler.requestCount,
              httpTimeMs: Number(fetchProfiler.totalTimeMs.toFixed(2)),
              httpTimeByAddress,
            };

            const syncedAlbums = await benchmarkDb.db.select({ id: albumsTable.id }).from(albumsTable);
            const syncedSongs = await benchmarkDb.db.select({ id: songsTable.id }).from(songsTable);

            console.info("benchmark:sync", benchmarkStats);

            expect(result.fetched).toBe(SYNC_BENCHMARK_ALBUM_COUNT);
            expect(syncedAlbums).toHaveLength(SYNC_BENCHMARK_ALBUM_COUNT);
            expect(syncedSongs).toHaveLength(SYNC_BENCHMARK_SONG_COUNT);
          } finally {
            await rm(coverArtDir, { recursive: true, force: true });
            sqlite.close();
          }
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
