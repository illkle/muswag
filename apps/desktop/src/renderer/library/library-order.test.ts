import { createCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { LIBRARY_ORDERS, songRow, type Song } from "@muswag/model";
import { afterEach, expect, it, vi } from "vitest";

import { songsInOrder } from "#/library/library-order";

// Titles a locale-aware or a code point comparison would order differently.
const titles = ["🎵 Notes", "�?", " Private", "ＡＢＣ", "abd", "Abc", "ábc", "zz", "Zz", "中文", "\u{1F600}", "", "a\u{10000}", "aＡ", "", "10", "9", "Abc"];
const rows = titles.map((title, index) => songRow({ id: `id-${index}`, title }));

const library = () => createCollection(localOnlyCollectionOptions({ getKey: ({ id }: Song) => id, initialData: rows }));

afterEach(() => {
  vi.useRealTimers();
});

const byColumns = (left: Song, right: Song) => {
  for (const column of LIBRARY_ORDERS.title) {
    if (left[column] < right[column]) return -1;
    if (left[column] > right[column]) return 1;
  }
  return 0;
};

/**
 * The Songs page sorts with TanStack DB and main with SQLite, and both must agree. Main's side of
 * this is in the queue sources' tests; each compares its database with plain string comparison.
 */
it("orders the library by its sort columns as plain strings", async () => {
  const sorted = songsInOrder(library(), "title");
  await sorted.preload();

  expect(sorted.toArray.map(({ id }) => id)).toEqual([...rows].sort(byColumns).map(({ id }) => id));
  expect(sorted.toArray.map(({ id }) => id)).not.toEqual(rows.map(({ id }) => id));
});

it("reads nothing until it is used, and then follows the table for as long as the window is open", async () => {
  vi.useFakeTimers();
  const songs = library();
  const sorted = songsInOrder(songs, "title");
  expect(sorted.status).toBe("idle");

  // A page reads the order and leaves, and nothing reads it for an hour.
  await sorted.preload();
  sorted.subscribeChanges(() => {}).unsubscribe();
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

  const added = songRow({ id: "added", title: "Abc" });
  songs.insert(added);
  songs.delete("id-0");
  await vi.advanceTimersByTimeAsync(20);

  // The next visit finds the order ready rather than sorting the table again.
  expect(sorted.status).toBe("ready");
  expect(sorted.toArray.map(({ id }) => id)).toEqual([...rows.slice(1), added].sort(byColumns).map(({ id }) => id));
});
