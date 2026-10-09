import { Schema } from "effect";

import type { Song } from "./db/schema.js";

/** The orders the whole library can be listed and played in. */
export const LibrarySort = Schema.Literals(["title"]);
export type LibrarySort = typeof LibrarySort.Type;

/**
 * The song columns each order sorts by, all ascending. Main sorts by them in SQLite and the renderer
 * in TanStack DB, and the two have to put the library in the same order. So every text column here
 * must compare the same way in both: byte by byte in SQLite, code unit by code unit in JavaScript.
 * Sort keys are built for that; an order ends with the id so that no two songs compare equal.
 */
export const LIBRARY_ORDERS = {
  title: ["titleSortKey", "id"],
} as const satisfies Record<LibrarySort, ReadonlyArray<keyof Song>>;

/**
 * The song columns an album is listed and played by, all ascending: main reads the album in this
 * order to play it and the album page lists it in the same one. A song without a disc or track
 * number comes before those that have one, which is what both databases do with a null. It ends
 * with the id for the same reason the library's orders do: track numbers can be missing or repeat.
 */
export const ALBUM_ORDER = ["discNumber", "track", "id"] as const satisfies ReadonlyArray<keyof Song>;

/**
 * What a song is sorted by in the alphabetical order: its title without case or accents.
 *
 * SQLite compares text by UTF-8 bytes, which is code point order, and JavaScript by UTF-16 code
 * units. The two disagree only about U+E000 to U+FFFF, which come before the characters beyond the
 * BMP as bytes but after them as code units. The key has none: they, and any unpaired surrogate,
 * are moved to a private-use plane beyond the BMP, keeping their order.
 */
export function titleSortKey(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[\uD800-￿]/gu, (char) => String.fromCodePoint(0xf0000 + char.charCodeAt(0) - 0xd800));
}
