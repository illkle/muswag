import { LIBRARY_ORDERS, type LibrarySort, type Song } from "@muswag/model";
import { createLiveQueryCollection, type Collection } from "@tanstack/react-db";

/**
 * The songs of the library in one of its orders, as a query that outlives the pages reading it.
 * Sorting the whole table is slow enough to notice in a large library, so it happens once, when a
 * page first asks, and the result follows the table from then on.
 *
 * Main reads the same columns in SQLite to play the library in this order. Its text comparison is
 * the lexical one, so the two put the songs in the same order.
 */
export const songsInOrder = (songs: Collection<Song, string, any>, sort: LibrarySort) =>
  createLiveQueryCollection({
    query: (q) => q.from({ song: songs }).orderBy(({ song }) => LIBRARY_ORDERS[sort].map((column) => song[column]), { stringSort: "lexical" }),
    // Never released: collecting it would bring the sort back on the next visit.
    gcTime: 0,
  });
