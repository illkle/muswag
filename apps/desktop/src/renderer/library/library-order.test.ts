import { createCollection, createLiveQueryCollection, localOnlyCollectionOptions } from "@tanstack/db";
import { LIBRARY_ORDERS, songRow } from "@muswag/model";
import { expect, it } from "vitest";

/**
 * The Songs page sorts with TanStack DB and main with SQLite, and both must agree. Main's side of
 * this is in the queue sources' tests; each compares its database with plain string comparison.
 */
it("orders the library by its sort columns as plain strings", async () => {
  // Titles a locale-aware or a code point comparison would order differently.
  const titles = ["🎵 Notes", "�?", " Private", "ＡＢＣ", "abd", "Abc", "ábc", "zz", "Zz", "中文", "\u{1F600}", "", "a\u{10000}", "aＡ", "", "10", "9", "Abc"];
  const rows = titles.map((title, index) => songRow({ id: `id-${index}`, title }));
  const songs = createCollection(localOnlyCollectionOptions({ getKey: ({ id }: (typeof rows)[number]) => id, initialData: rows }));

  const sorted = createLiveQueryCollection((q) => q.from({ song: songs }).orderBy(({ song }) => LIBRARY_ORDERS.title.map((column) => song[column]), { stringSort: "lexical" }));
  await sorted.preload();

  const expected = [...rows].sort((left, right) => {
    for (const column of LIBRARY_ORDERS.title) {
      if (left[column] < right[column]) return -1;
      if (left[column] > right[column]) return 1;
    }
    return 0;
  });
  expect(sorted.toArray.map(({ id }) => id)).toEqual(expected.map(({ id }) => id));
  expect(sorted.toArray.map(({ id }) => id)).not.toEqual(rows.map(({ id }) => id));
});
