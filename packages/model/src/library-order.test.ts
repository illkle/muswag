import { describe, expect, it } from "vitest";

import { titleSortKey } from "./library-order.js";

/** How JavaScript, and so TanStack DB's lexical sort, compares two strings. */
const byCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** How SQLite compares two text values: by their UTF-8 bytes, which is the order of their code points. */
const byCodePoints = (left: string, right: string) => {
  const [a, b] = [left, right].map((text) => [...text].map((char) => char.codePointAt(0)!)) as [number[], number[]];
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
};

const sorted = (values: readonly string[], compare: (left: string, right: string) => number) => [...values].sort(compare);

describe("titleSortKey", () => {
  it("ignores case and accents", () => {
    expect(titleSortKey("Élan Vital")).toBe(titleSortKey("elan vital"));
    expect(titleSortKey("  ÜBER ")).toBe("uber");
  });

  it("sorts titles alphabetically rather than by character code", () => {
    const titles = ["zebra", "Apple", "Élan", "banana", "Zoo", "eagle", "10 Years", "ａｂｃ"];

    expect(sorted(titles, (left, right) => byCodeUnits(titleSortKey(left), titleSortKey(right)))).toEqual(["10 Years", "ａｂｃ", "Apple", "banana", "eagle", "Élan", "zebra", "Zoo"]);
  });

  it("compares the same by code units as by code points", () => {
    // Characters on every side of the ranges the two comparisons disagree about, and an unpaired surrogate.
    const pieces = ["a", "z", "é", "я", "中", "퟿", "", "", "�", "Ａ", "🎵", "\u{1F600}", "\u{10000}", "\u{10FFFF}", "\uD83C", "\uDFB5", ""];
    const titles = pieces.flatMap((first) => pieces.flatMap((second) => pieces.map((third) => first + second + third)));
    const keys = [...new Set(titles.map(titleSortKey))];

    expect(sorted(keys, byCodeUnits)).toEqual(sorted(keys, byCodePoints));
    // Without the key the two orders differ, which is what it is for.
    expect(sorted(titles, byCodeUnits)).not.toEqual(sorted(titles, byCodePoints));
  });

  it("leaves no unpaired surrogate in a key, so SQLite stores it unchanged", () => {
    expect(/[\uD800-\uDFFF]/u.test(titleSortKey("a\uD83Cb"))).toBe(false);
  });
});
