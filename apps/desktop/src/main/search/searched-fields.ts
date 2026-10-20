import type { SearchHit } from "@muswag/model";

// What a search looks at. Main reads it to send the worker only the fields of a change that a search
// looks at; Fuse and the index stay in the worker.

/** The fields of a row that a search looks at, and the row's id. */
export type SearchedRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** What the index is built from: the searched fields of every album, artist and song. */
export type SearchedLibrary = { readonly albums: ReadonlyArray<SearchedRow>; readonly artists: ReadonlyArray<SearchedRow>; readonly songs: ReadonlyArray<SearchedRow> };

/** A change to a row of `SEARCHED_TABLES`, with only the fields a search looks at. */
export type SearchedChange = { readonly table: string; readonly type: "upsert"; readonly value: SearchedRow } | { readonly table: string; readonly type: "delete"; readonly key: string };

/**
 * A change as main sends it to the worker: what the index takes, or the id of a row that was written
 * where the mirror sends only the key, as it does for songs and albums. The worker reads that row itself.
 */
export type SearchWorkerChange = SearchedChange | { readonly table: string; readonly type: "changed"; readonly key: string };

/** The fields Fuse searches, by row type, with the weight of each. */
export const KEYS = ["song.artist", "song.album", "song.title", "song.year", "album.artist", { name: "album.name", weight: 3 }, "album.year", { name: "artist.name", weight: 2 }] as const;

/** The searched tables, with what a row of each is called in `KEYS`. */
export const TYPES = { albums: "album", artists: "artist", songs: "song" } as const satisfies Record<keyof SearchedLibrary, SearchHit["type"]>;
export const SEARCHED_TABLES: ReadonlySet<string> = new Set(Object.keys(TYPES));

/** The columns of each table that a search looks at. */
const searchedColumns = (type: SearchHit["type"]) =>
  KEYS.flatMap((key) => {
    const [owner, field] = (typeof key === "string" ? key : key.name).split(".");
    return owner === type && field ? [field] : [];
  });
export const SEARCHED_COLUMNS: Record<keyof SearchedLibrary, ReadonlyArray<string>> = { albums: searchedColumns("album"), artists: searchedColumns("artist"), songs: searchedColumns("song") };
