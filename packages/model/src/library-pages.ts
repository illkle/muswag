import { Schema } from "effect";

import { Id } from "./contract.js";
import type { LibrarySong } from "./db/mirror.js";
import type { Album } from "./db/schema.js";

/** Rows in one page of the songs list. */
export const PageLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }));
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Which songs of an order of the library a page holds: `limit` songs from the `offset`th on, or those
 * right after or right before a song, found by its id. Main finds the songs around a song through the
 * order's index, where an offset makes it count every song before; the list asks that way for the page
 * after one it holds.
 */
export const SongPageRequest = Schema.Union([Schema.Struct({ offset: Offset, limit: PageLimit }), Schema.Struct({ after: Id, limit: PageLimit }), Schema.Struct({ before: Id, limit: PageLimit })]);
export type SongPageRequest = typeof SongPageRequest.Type;

/** A page of the songs list, in list order. `total` when it was asked for. `null` for a page around a song the library no longer has. */
export type SongPage = { readonly songs: ReadonlyArray<LibrarySong>; readonly total: number | null } | null;

/** Positions in the songs list, from `start` up to `end`, which is not included. */
export const SongRange = Schema.Struct({ start: Offset, end: Offset });
export type SongRange = typeof SongRange.Type;
export const SongRanges = Schema.Array(SongRange).check(Schema.isMaxLength(10_000));

/**
 * Which albums of the albums page a page holds: `limit` albums from the `offset`th on. A library has
 * far fewer albums than songs, so counting those before the offset costs little.
 */
export const AlbumPageRequest = Schema.Struct({ offset: Offset, limit: PageLimit });
export type AlbumPageRequest = typeof AlbumPageRequest.Type;

/** A page of the albums page, newest first. `total` when it was asked for. */
export type AlbumPage = { readonly albums: ReadonlyArray<Album>; readonly total: number | null };
