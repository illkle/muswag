import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";

import { LibrarySync } from "@muswag/core";
import { apiAlbum, apiLayer, apiSong, idsOf, TestDatabase } from "@muswag/core/testing";
import { albums, songs } from "@muswag/shared";
import { Effect, Layer } from "effect";

describe("sync storage benchmark", () => {
  it("syncs a large library into the database through the mirror", async () => {
    const count = 5_000;
    const listed = Array.from({ length: count }, (_, index) => apiAlbum(`album-${index}`));
    const api = apiLayer({
      getIndexes: () => Effect.succeed({ status: "ok", version: "1.16.1", indexes: { lastModified: 1 } }),
      getAlbumList2: ({ offset = 0, size = 500 }) => Effect.succeed({ status: "ok", version: "1.16.1", albumList2: { album: listed.slice(offset, offset + size) } }),
      getAlbum: ({ id }) => Effect.succeed({ status: "ok", version: "1.16.1", album: { ...listed.find((album) => album.id === id)!, song: [apiSong(`song-${id}`, id)] } }),
    });

    const startedAt = performance.now();
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        yield* LibrarySync.use((library) => library.sync("full"));
        return { albums: yield* idsOf(albums), songs: yield* idsOf(songs) };
      }).pipe(Effect.provide(LibrarySync.layer.pipe(Layer.provideMerge(Layer.mergeAll(TestDatabase(), api))))),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(stored.albums).toHaveLength(count);
    expect(stored.songs).toHaveLength(count);
    console.info("sync-storage-benchmark", { albums: count, songs: count, elapsedMs: Math.round(elapsedMs) });
  });
});
