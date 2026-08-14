import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { queryOnce } from "@tanstack/db";
import { createInMemoryDb } from "#core/testing/database";

describe("sync storage benchmark", () => {
  it("keeps a large library scan independent from the singleton player queue table", async () => {
    const db = createInMemoryDb();
    const count = 5_000;
    const albums = Array.from({ length: count }, (_, index) => ({
      id: `album-${index}`,
      name: `Album ${index}`,
      isDir: true as const,
      songCount: 1,
      duration: 60,
      created: "2026-01-01",
      artist: "Artist",
      coverArtPath: undefined,
    }));
    const songs = Array.from({ length: count }, (_, index) => ({ id: `song-${index}`, albumId: `album-${index}`, album: `Album ${index}`, title: `Song ${index}`, isDir: false as const }));

    const startedAt = performance.now();
    await Promise.all([db.albums.insert(albums).isPersisted.promise, db.songs.insert(songs).isPersisted.promise]);
    await db.playerQueue.insert({
      id: 1,
      snapshot: { version: 1, savedAt: new Date().toISOString(), nowPlaying: null, userQueue: [], source: null, playback: { paused: false, positionSeconds: 0 } },
    }).isPersisted.promise;
    const [storedAlbums, storedSongs] = await Promise.all([queryOnce((q) => q.from({ album: db.albums })), queryOnce((q) => q.from({ song: db.songs }))]);
    const elapsedMs = performance.now() - startedAt;

    expect(storedAlbums).toHaveLength(count);
    expect(storedSongs).toHaveLength(count);
    expect(db.playerQueue.size).toBe(1);
    console.info("sync-storage-benchmark", { albums: count, songs: count, elapsedMs: Math.round(elapsedMs) });
  });
});
