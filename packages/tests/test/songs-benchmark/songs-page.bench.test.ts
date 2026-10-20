// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";

import { LibraryQueries } from "@muswag/backend";
import type { LibrarySort, SongPageRequest } from "@muswag/model";
import { describe, it } from "vitest";

import { median, openLibrary, recorder, SIZES, type Library } from "./harness.js";

const PAGE = 100;
const SORTS: ReadonlyArray<LibrarySort> = ["title", "artist", "album"];

/**
 * The songs page: the pages main reads for it in each order, the count it sizes the list by, where
 * typed letters jump to, and the ids of a selection of everything. Each read goes through the copy
 * IPC makes, the way the page gets it.
 */
describe("songs page", () => {
  const { record, save } = recorder("songs-page");

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
    const page = (sort: LibrarySort, request: SongPageRequest, withTotal = false) => library.run(LibraryQueries.songPage(sort, request, withTotal));

    for (const sort of SORTS) {
      record(size, `${sort}: first open (page + count)`, await timed(library, () => page(sort, { offset: 0, limit: PAGE }, true)));
      record(size, `${sort}: page by offset, middle`, await timed(library, () => page(sort, { offset: Math.floor(size / 2), limit: PAGE })));
      record(size, `${sort}: page by offset, end`, await timed(library, () => page(sort, { offset: size - PAGE, limit: PAGE })));
      const middle = await page(sort, { offset: Math.floor(size / 2), limit: PAGE });
      const end = await page(sort, { offset: size - 2 * PAGE, limit: PAGE });
      record(size, `${sort}: page after a page, middle`, await timed(library, () => page(sort, { after: middle!.songs.at(-1)!.id, limit: PAGE })));
      record(size, `${sort}: page after a page, end`, await timed(library, () => page(sort, { after: end!.songs.at(-1)!.id, limit: PAGE })));
      record(size, `${sort}: page before a page, end`, await timed(library, () => page(sort, { before: end!.songs[0]!.id, limit: PAGE })));
      record(size, `${sort}: jump to typed "m"`, await timed(library, () => library.run(LibraryQueries.songPosition(sort, "m"))));
    }

    library.resetStats();
    record(size, "title: ids of everything selected", await timed(library, () => library.run(LibraryQueries.songIds("title", [{ start: 0, end: size }])), 3));
    record(size, "  IPC: bytes", library.stats.bytes / 3 / 1024 / 1024, "MB");

    await library.dispose();
  });

  it("saves", () => save());
});
