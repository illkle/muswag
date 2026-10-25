// oxlint-disable vitest/expect-expect -- a benchmark reports what it measures rather than asserting it
import { performance } from "node:perf_hooks";

import { ALBUM_ORDER, albums, MAIN_ONLY_SONG_COLUMNS, songs } from "@muswag/model";
import { mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { BasicIndex, createCollection, createLiveQueryCollection, eq, inArray, isUndefined, not } from "@tanstack/db";
import { describe, it } from "vitest";

import { heapMb, median, openLibrary, recorder, SIZES, waitFor, type Library } from "./harness.js";
import { sampleAlbums } from "./samples.js";

/** The collections as the renderer makes them: albums and songs both read on demand. */
const collectionsOf = (library: Library) => {
  const options = { client: library.client, gcTime: 0, defaultIndexType: BasicIndex } as const;
  const albumCollection = createCollection(mirrorCollectionOptions({ ...options, table: albums, syncMode: "on-demand", autoIndex: "eager" }));
  const songCollection = createCollection(mirrorCollectionOptions({ ...options, table: songs, omit: MAIN_ONLY_SONG_COLUMNS, syncMode: "on-demand", autoIndex: "eager" }));
  return { albumCollection, songCollection };
};

/**
 * The pages that read songs through the on-demand collection: an album, an artist's albums, a
 * playlist. How long each takes to open from nothing, how a change reaches one that is open, and
 * whether opening and closing pages leaves anything behind.
 */
describe("on-demand pages", () => {
  const { record, save } = recorder("on-demand-pages");

  it.each(SIZES)("%i songs", async (size) => {
    const library = await openLibrary(size);
    const { albumCollection, songCollection } = collectionsOf(library);

    const albumPage = (albumId: string) =>
      createLiveQueryCollection({
        query: (q) =>
          q
            .from({ song: songCollection })
            .where(({ song }) => eq(song.albumId, albumId))
            .orderBy(({ song }) => ALBUM_ORDER.map((column) => song[column]), { stringSort: "lexical", nulls: "first" }),
        gcTime: 0,
      });

    const albumIds = await sampleAlbums(library);
    const albumTimes: Array<number> = [];
    library.resetStats();
    for (const albumId of albumIds) {
      const started = performance.now();
      const page = albumPage(albumId);
      await page.preload();
      albumTimes.push(performance.now() - started);
      await page.cleanup();
    }
    record(size, "album page", median(albumTimes));
    record(size, "  requests per album", library.stats.requests / albumIds.length, "");

    // The artists with the most albums, whose pages read the most songs.
    const artists = await library.query<{ artistId: string }>(`SELECT artistId FROM albums WHERE artistId IS NOT NULL GROUP BY artistId ORDER BY count(*) DESC LIMIT 10`);
    const artistTimes: Array<number> = [];
    library.resetStats();
    let artistSongs = 0;
    for (const { artistId } of artists) {
      const started = performance.now();
      const page = createLiveQueryCollection({
        query: (q) =>
          // As the artist page joins them: from the albums, so only their songs are read.
          q
            .from({ album: albumCollection })
            .where(({ album }) => eq(album.artistId, artistId))
            .leftJoin({ song: songCollection }, ({ song, album }) => eq(song.albumId, album.id))
            .where(({ song }) => not(isUndefined(song)))
            .select(({ song }) => song),
        gcTime: 0,
      });
      await page.preload();
      artistTimes.push(performance.now() - started);
      artistSongs += page.size;
      await page.cleanup();
    }
    record(size, "artist page (most albums)", median(artistTimes));
    record(size, "  songs per artist", artistSongs / artists.length, "");
    record(size, "  requests per artist", library.stats.requests / artists.length, "");
    record(size, "  main per artist", library.stats.serverMs / artists.length);

    for (const length of [1_000, 5_000]) {
      const ids = (await library.query<{ id: string }>(`SELECT id FROM songs ORDER BY random() LIMIT ?`, [length])).map(({ id }) => id);
      const started = performance.now();
      const playlist = createLiveQueryCollection({ query: (q) => q.from({ song: songCollection }).where(({ song }) => inArray(song.id, ids)), gcTime: 0 });
      await playlist.preload();
      record(size, `playlist of ${length} songs`, performance.now() - started);
      await playlist.cleanup();
    }

    // A play count changing on an album page that is open, and a stats refresh of songs elsewhere.
    const open = albumPage(albumIds[0]!);
    await open.preload();
    const [first] = open.toArray;
    let started = performance.now();
    let seen = waitFor(open, () => open.get(first!.id)?.playCount === 1000);
    await library.exec(`UPDATE songs SET playCount = 1000 WHERE id = ?`, [first!.id]);
    await seen;
    record(size, "a change reaches an open album page", performance.now() - started);

    library.resetStats();
    started = performance.now();
    seen = waitFor(open, () => open.get(first!.id)?.playCount === 7);
    await library.exec(`UPDATE songs SET playCount = 7 WHERE rowid IN (SELECT rowid FROM songs ORDER BY rowid DESC LIMIT 999) OR id = ?`, [first!.id]);
    await seen;
    record(size, "1000 changes reach an open album page", performance.now() - started);
    record(size, "  requests", library.stats.requests, "");
    await open.cleanup();

    // Opening and closing a thousand album pages should leave nothing behind.
    await waitFor(songCollection, () => songCollection.size === 0);
    const before = heapMb();
    for (let round = 0; round < 50; round++) {
      for (const albumId of albumIds) {
        const page = albumPage(albumId);
        await page.preload();
        await page.cleanup();
      }
    }
    await waitFor(songCollection, () => songCollection.size === 0);
    record(size, "heap after 1000 album pages opened and closed", heapMb() - before, "MB");

    await songCollection.cleanup();
    await albumCollection.cleanup();
    await library.dispose();
  });

  it("saves", () => save());
});
