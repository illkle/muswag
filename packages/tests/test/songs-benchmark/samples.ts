import type { Library } from "./harness.js";

/** Twenty albums spread over the library, the same for every option. */
export const sampleAlbums = async (library: Library) =>
  (
    await library.query<{ albumId: string }>(`SELECT albumId FROM songs WHERE albumId IS NOT NULL GROUP BY albumId ORDER BY albumId LIMIT 20 OFFSET (SELECT count(DISTINCT albumId) / 2 FROM songs)`)
  ).map(({ albumId }) => albumId);

/** Twenty songs from the first screen of the songs page. */
export const sampleWindowSongs = async (library: Library) => (await library.query<{ id: string }>(`SELECT id FROM songs ORDER BY titleSortKey, id LIMIT 20 OFFSET 10`)).map(({ id }) => id);
