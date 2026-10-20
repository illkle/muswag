import { describe, expect, it } from "vitest";

import { albumOrderKey, artistOrderKey, sortKey } from "./library-order.js";

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

describe("sortKey", () => {
  it("ignores case and accents", () => {
    expect(sortKey("Élan Vital")).toBe(sortKey("elan vital"));
    expect(sortKey("  ÜBER ")).toBe("uber");
  });

  it("sorts titles alphabetically rather than by character code", () => {
    const titles = ["zebra", "Apple", "Élan", "banana", "Zoo", "eagle", "10 Years", "ａｂｃ"];

    expect(sorted(titles, (left, right) => byCodeUnits(sortKey(left), sortKey(right)))).toEqual(["10 Years", "ａｂｃ", "Apple", "banana", "eagle", "Élan", "zebra", "Zoo"]);
  });

  it("compares the same by code units as by code points", () => {
    // Characters on every side of the ranges the two comparisons disagree about, and an unpaired surrogate.
    const pieces = ["a", "z", "é", "я", "中", "퟿", "", "", "�", "Ａ", "🎵", "\u{1F600}", "\u{10000}", "\u{10FFFF}", "\uD83C", "\uDFB5", ""];
    const titles = pieces.flatMap((first) => pieces.flatMap((second) => pieces.map((third) => first + second + third)));
    const keys = [...new Set(titles.map(sortKey))];

    expect(sorted(keys, byCodeUnits)).toEqual(sorted(keys, byCodePoints));
    // Without the key the two orders differ, which is what it is for.
    expect(sorted(titles, byCodeUnits)).not.toEqual(sorted(titles, byCodePoints));
  });

  it("leaves no unpaired surrogate in a key, so SQLite stores it unchanged", () => {
    expect(/[\uD800-\uDFFF]/u.test(sortKey("a\uD83Cb"))).toBe(false);
  });
});

describe("order keys", () => {
  const song = (artist: string | null, album: string | null, albumId: string | null, discNumber: number | null, track: number | null) => ({ artist, album, albumId, discNumber, track });
  const byKey = (key: (value: ReturnType<typeof song>) => string, songs: ReturnType<typeof song>[]) => [...songs].sort((left, right) => byCodePoints(key(left), key(right)));

  it("puts an album's songs together, by disc then track, those without a number first", () => {
    const songs = [song("A", "Blue", "b", 1, 2), song("A", "Blue", "b", null, null), song("A", "Blue", "b", 2, 1), song("A", "Blue", "b", 1, 10), song("A", "Blue", "b", 1, 1)];
    expect(byKey(albumOrderKey, songs).map(({ discNumber, track }) => `${discNumber}:${track}`)).toEqual(["null:null", "1:1", "1:2", "1:10", "2:1"]);
  });

  it("keeps two albums of the same name apart", () => {
    const songs = [song("A", "Hits", "x", 1, 1), song("B", "Hits", "y", 1, 1), song("A", "Hits", "x", 1, 2), song("B", "Hits", "y", 1, 2)];
    expect(byKey(albumOrderKey, songs).map(({ albumId }) => albumId)).toEqual(["x", "x", "y", "y"]);
  });

  it("sorts by artist, then album, a shorter name before a longer one that starts the same", () => {
    const songs = [song("abc d", "a", "1", 1, 1), song("ABC", "z", "2", 1, 1), song("Abc", "b", "3", 1, 1), song(null, "a", "4", 1, 1)];
    expect(byKey(artistOrderKey, songs).map(({ albumId }) => albumId)).toEqual(["4", "3", "2", "1"]);
  });
});
