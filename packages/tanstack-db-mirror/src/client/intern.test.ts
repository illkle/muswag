import { describe, expect, it } from "vitest";

import { internStrings, type Interned } from "./intern.js";

/** A string equal to `value` that is another copy of it, as structured clone gives. */
const copyOf = (value: string) => value.split("").join("");

describe("internStrings", () => {
  // Which copy a string is cannot be seen from JavaScript; the heap snapshot shows it. What can be seen is
  // that each distinct string is kept once, at any depth, and that the values stay as they were.
  it("keeps each distinct string once, at any depth, leaving the values as they were", () => {
    const interned: Interned = new Map();
    const first = internStrings({ artist: copyOf("Artist Name"), artists: [{ id: copyOf("ar-1"), name: copyOf("Artist Name") }] }, interned);
    const second = internStrings({ artist: copyOf("Artist Name"), artists: [{ id: copyOf("ar-1"), name: copyOf("Artist Name") }] }, interned);

    expect(second).toEqual({ artist: "Artist Name", artists: [{ id: "ar-1", name: "Artist Name" }] });
    expect(second).toEqual(first);
    expect([...interned.keys()]).toEqual(["Artist Name", "ar-1"]);
  });

  it("leaves numbers, nulls and other objects as they are", () => {
    const date = new Date(0);
    const row = internStrings({ count: 3, missing: null, flag: true, date }, new Map());

    expect(row).toEqual({ count: 3, missing: null, flag: true, date });
    expect(row.date).toBe(date);
  });
});
