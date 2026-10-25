// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";

import { LibraryQueries } from "@muswag/backend";
import { describe, it } from "vitest";

import { median, openLibrary, recorder, SIZES, type Library } from "./harness.js";
import { sampleAlbums } from "./samples.js";

/**
 * The pages that show some of the library rather than a list of all of it: an album, an artist's
 * albums with their songs, a playlist's songs. Each is one read of main's, its result copied as IPC
 * copies it. The libraries repeat their albums under the same artists, so the artists with the most
 * albums have far more of them here than anyone has.
 */
describe("detail pages", () => {
  const { record, save } = recorder("detail-pages");

  /** The median time of `read` over `inputs`, its result copied as IPC would, and how much it copied on average. */
  const timed = async <T>(library: Library, inputs: ReadonlyArray<T>, read: (input: T) => Promise<unknown>) => {
    const samples: Array<number> = [];
    library.resetStats();
    for (const input of inputs) {
      const started = performance.now();
      library.copy(await read(input));
      samples.push(performance.now() - started);
    }
    return { ms: median(samples), kb: library.stats.bytes / inputs.length / 1024 };
  };

  it.each(SIZES)("%i songs", async (size) => {
    const library = await openLibrary(size);

    const albumIds = await sampleAlbums(library);
    const album = await timed(library, albumIds, (id) => library.run(LibraryQueries.album(id)));
    record(size, "album page", album.ms);
    record(size, "  copied per album", album.kb, "KB");

    const artists = (await library.query<{ artistId: string }>(`SELECT artistId FROM albums WHERE artistId IS NOT NULL GROUP BY artistId ORDER BY count(*) DESC LIMIT 10`)).map(
      ({ artistId }) => artistId,
    );
    const discography = await timed(library, artists, (id) => library.run(LibraryQueries.discography(id)));
    record(size, "artist's albums and songs (most albums)", discography.ms);
    record(size, "  copied per artist", discography.kb, "KB");
    record(size, "artist page (most albums)", (await timed(library, artists, (id) => library.run(LibraryQueries.artist(id)))).ms);

    for (const length of [1_000, 5_000]) {
      const ids = (await library.query<{ id: string }>(`SELECT id FROM songs ORDER BY random() LIMIT ?`, [length])).map(({ id }) => id);
      record(size, `playlist of ${length} songs`, (await timed(library, [ids, ids, ids], (songIds) => library.run(LibraryQueries.librarySongsByIds(songIds)))).ms);
    }

    await library.dispose();
  });

  it("saves", () => save());
});
