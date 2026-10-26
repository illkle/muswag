// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";

import { LibraryQueries } from "@muswag/backend";
import { describe, it } from "vitest";

import { heapMb, median, openLibrary, recorder, SIZES, type Library } from "./harness.js";

const PAGE = 100;

/**
 * The albums, which the renderer reads from main as it does the songs: the pages of the albums page,
 * the artists that have albums of their own, the cover ids of the albums of the rows a list draws, and
 * the albums of a list of them, as an artist's "appears on" asks.
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

    const page = (offset: number, withTotal = false) => library.run(LibraryQueries.albumPage("year-desc", { offset, limit: PAGE }, withTotal));
    record(size, "albums page: first open (page + count)", await timed(library, () => page(0, true)));
    record(size, "albums page: page by offset, middle", await timed(library, () => page(Math.floor(count / 2))));
    record(size, "albums page: page by offset, end", await timed(library, () => page(Math.max(0, count - PAGE))));
    const heapBefore = heapMb();
    const held = await Promise.all([0, 1, 2].map((index) => page(index * PAGE)));
    record(size, "renderer heap: 3 pages", heapMb() - heapBefore, "MB");
    held.length = 0;

    record(size, "artists page: artists with albums", await timed(library, () => library.run(LibraryQueries.artistIndex())));
    const ids = (await library.query<{ id: string }>(`SELECT id FROM albums ORDER BY random() LIMIT 30`)).map(({ id }) => id);
    record(size, "covers of 30 rows' albums", await timed(library, () => library.run(LibraryQueries.albumCoverArts(ids))));

    record(size, "albums of 30 ids", await timed(library, () => library.run(LibraryQueries.albumsByIds(ids))));

    await library.dispose();
  });

  it("saves", () => save());
});
