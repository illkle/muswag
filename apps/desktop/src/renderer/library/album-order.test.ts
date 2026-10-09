import { createCollection, createLiveQueryCollection, eq, localOnlyCollectionOptions } from "@tanstack/db";
import { ALBUM_ORDER, songRow, type Song } from "@muswag/model";
import { expect, it } from "vitest";

/**
 * The album page lists an album with TanStack DB and main reads it from SQLite to play it, and the two
 * have to agree, also where disc and track numbers are missing or repeat. Main's side is the test
 * "orders an album as the album page does" of the queue sources, with the same songs and the same
 * order spelled out.
 */
it("orders an album by `ALBUM_ORDER`, with no number before any number", async () => {
  const numbered: Array<[id: string, discNumber: number | null, track: number | null]> = [
    ["m", 1, 2],
    ["b", 2, 1],
    ["z", null, null],
    ["k", 1, 2],
    ["c", 1, null],
    ["a", 2, null],
    ["y", null, 3],
    ["d", 1, 1],
    ["e", null, null],
    ["B", 1, 2],
    ["x", null, 1],
  ];
  const rows = numbered.map(([id, discNumber, track]) => songRow({ id, title: id, albumId: "album", discNumber, track }));
  const songs = createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Song) => id, initialData: [...rows, songRow({ id: "other", title: "other", albumId: "other" })] }));

  // The query of the album page.
  const sorted = createLiveQueryCollection((q) =>
    q
      .from({ song: songs })
      .where(({ song }) => eq(song.albumId, "album"))
      .orderBy(({ song }) => ALBUM_ORDER.map((column) => song[column]), { stringSort: "lexical", nulls: "first" }),
  );
  await sorted.preload();

  expect(sorted.toArray.map(({ id }) => id)).toEqual(["e", "z", "x", "y", "c", "d", "B", "k", "m", "a", "b"]);
});
