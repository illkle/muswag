import { Schema } from "effect";

import type { Album, Song } from "./db/schema.js";

/** What the whole library can be listed and played by: title, artist, or album. */
export type LibrarySortBy = "title" | "artist" | "album";

/** The orders the whole library can be listed and played in: by title, by artist, or by album, each going up or, with `-desc`, down. */
export const LibrarySort = Schema.Literals(["title", "artist", "album", "title-desc", "artist-desc", "album-desc"]);
export type LibrarySort = typeof LibrarySort.Type;

/** What an order goes by, and whether it goes down. */
export const librarySortParts = (sort: LibrarySort): { by: LibrarySortBy; descending: boolean } => ({
  by: sort.replace(/-desc$/, "") as LibrarySortBy,
  descending: sort.endsWith("-desc"),
});

/**
 * The song columns each order sorts by, all ascending, or all descending for an order that goes down.
 * Only SQLite sorts the library, by these, with an index on each pair: the first is a key made by
 * `toSongRow` from what the order goes by, and the id after it keeps two songs from comparing equal.
 * Being one text column, a key compares the same however it is read, and it is never null, so a
 * song's place is found with a row value comparison.
 */
export const LIBRARY_ORDERS = {
  title: ["titleSortKey", "id"],
  artist: ["artistOrderKey", "id"],
  album: ["albumOrderKey", "id"],
} as const satisfies Record<LibrarySortBy, readonly [keyof Song, "id"]>;

/**
 * The orders of the albums page: by year, newest or oldest first, by artist, either way, or the most
 * recently added first. Albums are few enough for SQLite to sort them for each page.
 */
export const AlbumSort = Schema.Literals(["year-desc", "year", "artist", "artist-desc", "added"]);
export type AlbumSort = typeof AlbumSort.Type;

/**
 * The song columns an album is listed and played by, all ascending: main reads the album in this
 * order to play it and the album page lists it in the same one. A song without a disc or track
 * number comes before those that have one, which is what both databases do with a null. It ends
 * with the id for the same reason the library's orders do: track numbers can be missing or repeat.
 */
export const ALBUM_ORDER = ["discNumber", "track", "id"] as const satisfies ReadonlyArray<keyof Song>;

/**
 * How an artist's albums follow one another on the artists page and when they are played from it:
 * the newest first, those without a year after every dated one, and by id where the years tie. Each
 * album's songs are then in `ALBUM_ORDER`.
 */
export const ARTIST_ALBUM_ORDER = [
  { column: "year", direction: "desc" },
  { column: "id", direction: "asc" },
] as const satisfies ReadonlyArray<{ column: keyof Album; direction: "asc" | "desc" }>;

/**
 * What a text is sorted by: without case or accents. Titles, artists and albums are each sorted by theirs.
 *
 * SQLite compares text by UTF-8 bytes, which is code point order, and JavaScript by UTF-16 code
 * units. The two disagree only about U+E000 to U+FFFF, which come before the characters beyond the
 * BMP as bytes but after them as code units. The key has none: they, and any unpaired surrogate,
 * are moved to a private-use plane beyond the BMP, keeping their order.
 */
export function sortKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[\uD800-\uFFFF]/gu, (char) => String.fromCodePoint(0xf0000 + char.charCodeAt(0) - 0xd800));
}

/** Between the parts of an order key. It comes before every character a sort key has, so "abc" sorts before "abc d". */
const PART = "\u0001";
/** A disc or track number in an order key, padded to compare as a number; none comes before every number. */
const number = (value: number | null | undefined) => (value == null ? "" : String(Math.max(0, Math.trunc(value))).padStart(6, "0"));

/** What the album order sorts a song by: its album's name, the album, then where on it the song is. */
export const albumOrderKey = (song: Pick<Song, "album" | "albumId" | "discNumber" | "track">) =>
  [sortKey(song.album ?? ""), song.albumId ?? "", number(song.discNumber), number(song.track)].join(PART);

/** What the artist order sorts a song by: its artist, then as the album order does. */
export const artistOrderKey = (song: Pick<Song, "artist" | "album" | "albumId" | "discNumber" | "track">) => [sortKey(song.artist ?? ""), albumOrderKey(song)].join(PART);
