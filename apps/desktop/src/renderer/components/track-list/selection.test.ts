import { describe, expect, it } from "vitest";

import { EMPTY_SELECTION, selectAll, selectForAction, selectOnClick, type SelectionState } from "#/components/track-list/selection";

const order = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

const click = (state: SelectionState, key: string, modifiers = plain) => selectOnClick(state, order, key, modifiers);
const keysOf = (state: SelectionState) => [...state.keys].sort();

describe("track list selection", () => {
  it("selects only the clicked row", () => {
    const state = click(click(EMPTY_SELECTION, "a"), "c");

    expect(keysOf(state)).toEqual(["c"]);
  });

  it("adds and removes rows with a toggling click", () => {
    const added = click(click(EMPTY_SELECTION, "a"), "c", toggle);
    expect(keysOf(added)).toEqual(["a", "c"]);

    expect(keysOf(click(added, "a", toggle))).toEqual(["c"]);
  });

  it("selects from the anchor to the clicked row, in either direction", () => {
    const anchored = click(EMPTY_SELECTION, "c");

    expect(keysOf(click(anchored, "e", range))).toEqual(["c", "d", "e"]);
    expect(keysOf(click(anchored, "a", range))).toEqual(["a", "b", "c"]);
  });

  it("keeps the anchor across range clicks, so a second one replaces the first range", () => {
    const state = click(click(click(EMPTY_SELECTION, "c"), "e", range), "b", range);

    expect(keysOf(state)).toEqual(["b", "c"]);
  });

  it("anchors a range at the row last toggled", () => {
    const state = click(click(click(EMPTY_SELECTION, "a"), "c", toggle), "e", range);

    expect(keysOf(state)).toEqual(["c", "d", "e"]);
  });

  it("selects only the clicked row when a range has no anchor in the list", () => {
    expect(keysOf(click(EMPTY_SELECTION, "c", range))).toEqual(["c"]);
    expect(keysOf(click({ keys: new Set(["gone"]), anchor: "gone" }, "c", range))).toEqual(["c"]);
  });

  it("keeps the selection for an action on a row that is part of it", () => {
    const state = click(click(EMPTY_SELECTION, "a"), "c", toggle);

    expect(selectForAction(state, "c")).toBe(state);
  });

  it("selects only the row for an action on a row outside the selection", () => {
    const state = click(click(EMPTY_SELECTION, "a"), "c", toggle);

    expect(keysOf(selectForAction(state, "d"))).toEqual(["d"]);
  });

  it("selects every row", () => {
    expect(keysOf(selectAll(order))).toEqual(order);
  });
});
