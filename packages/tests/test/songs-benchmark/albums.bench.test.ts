// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";

import { LibraryQueries } from "@muswag/backend";
import { albums } from "@muswag/model";
import { mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { BasicIndex, createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import { describe, it } from "vitest";

import { heapMb, median, openLibrary, recorder, SIZES, type Library } from "./harness.js";

const PAGE = 100;

/**
 * The albums, which the renderer reads from main as it does the songs: the pages of the albums page,
 * the artists that have albums of their own, the cover ids of the albums of the rows a list draws, and
 * the album and artist pages through the on-demand collection.
 */
describe("albums", () => {
  const { record, save } = recorder("albums");

  /** The median time of `times` runs of `read`, its result copied as IPC would. */
  const timed = async (library: Library, read: () => Promise<unknown>, times = 20) => {
    const samples: Array<number> = [];
    for (let i = 0; i < times; i++) {
      const started = performance.now();
      library.copy(await read());
      samples.push(performance.now() - started);
    }
    return median(samples);
  };

  it.each(SIZES)("%i songs", async (size) => {
    const library = await openLibrary(size);
    const [{ count } = { count: 0 }] = await library.query<{ count: number }>(`SELECT count(*) AS count FROM albums`);
    record(size, "albums", count, "");

    const page = (offset: number, withTotal = false) => library.run(LibraryQueries.albumPage({ offset, limit: PAGE }, withTotal));
    record(size, "albums page: first open (page + count)", await timed(library, () => page(0, true)));
    record(size, "albums page: page by offset, middle", await timed(library, () => page(Math.floor(count / 2))));
    record(size, "albums page: page by offset, end", await timed(library, () => page(Math.max(0, count - PAGE))));
    const heapBefore = heapMb();
    const held = await Promise.all([0, 1, 2].map((index) => page(index * PAGE)));
    record(size, "renderer heap: 3 pages", heapMb() - heapBefore, "MB");
    held.length = 0;

    record(size, "artists page: artists with albums", await timed(library, () => library.run(LibraryQueries.artistsWithAlbums())));
    const ids = (await library.query<{ id: string }>(`SELECT id FROM albums ORDER BY random() LIMIT 30`)).map(({ id }) => id);
    record(size, "covers of 30 rows' albums", await timed(library, () => library.run(LibraryQueries.albumCoverArts(ids))));

    // An album's page and an artist's, through the on-demand albums.
    const collection = createCollection(
      mirrorCollectionOptions({ client: library.client, table: albums, readOnly: true, gcTime: 0, defaultIndexType: BasicIndex, syncMode: "on-demand", autoIndex: "eager" }),
    );
    const albumTimes: Array<number> = [];
    for (const id of ids.slice(0, 20)) {
      const started = performance.now();
      const query = createLiveQueryCollection({ query: (q) => q.from({ album: collection }).where(({ album }) => eq(album.id, id)), gcTime: 0 });
      await query.preload();
      albumTimes.push(performance.now() - started);
      await query.cleanup();
    }
    record(size, "album page header", median(albumTimes));
    const artists = (await library.query<{ artistId: string }>(`SELECT artistId FROM albums WHERE artistId IS NOT NULL GROUP BY artistId ORDER BY count(*) DESC LIMIT 10`)).map(
      ({ artistId }) => artistId,
    );
    const artistTimes: Array<number> = [];
    for (const artistId of artists) {
      const started = performance.now();
      const query = createLiveQueryCollection({ query: (q) => q.from({ album: collection }).where(({ album }) => eq(album.artistId, artistId)), gcTime: 0 });
      await query.preload();
      artistTimes.push(performance.now() - started);
      await query.cleanup();
    }
    record(size, "artist page albums (most albums)", median(artistTimes));

    await collection.cleanup();
    await library.dispose();
  });

  it("saves", () => save());
});
