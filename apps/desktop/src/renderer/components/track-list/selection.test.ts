import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  EMPTY_SPANS,
  mergeSpans,
  selectAll,
  selectAllPositions,
  selectForAction,
  selectOnClick,
  selectPositionForAction,
  selectPositionOnClick,
  spansHave,
  spansSize,
  type SelectionState,
  type SpanSelection,
} from "#/components/track-list/selection";

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

describe("track list selection by position", () => {
  const spansOf = (state: SpanSelection) => state.spans.map(({ start, end }) => [start, end]);

  it("selects a row, then a range from it, in either direction", () => {
    const anchored = selectPositionOnClick(EMPTY_SPANS, 5, plain);
    expect(spansOf(selectPositionOnClick(anchored, 9, range))).toEqual([[5, 10]]);
    expect(spansOf(selectPositionOnClick(anchored, 2, range))).toEqual([[2, 6]]);
  });

  it("adds and takes out rows with a toggling click, joining the spans they touch", () => {
    let state = selectPositionOnClick(EMPTY_SPANS, 3, plain);
    state = selectPositionOnClick(state, 5, toggle);
    expect(spansOf(state)).toEqual([
      [3, 4],
      [5, 6],
    ]);
    state = selectPositionOnClick(state, 4, toggle);
    expect(spansOf(state)).toEqual([[3, 6]]);
    state = selectPositionOnClick(state, 4, toggle);
    expect(spansOf(state)).toEqual([
      [3, 4],
      [5, 6],
    ]);
  });

  it("selects everything as one span, however long the list", () => {
    const state = selectAllPositions(250_000);
    expect(spansOf(state)).toEqual([[0, 250_000]]);
    expect(spansSize(state.spans)).toBe(250_000);
    expect(spansOf(selectAllPositions(0))).toEqual([]);
  });

  it("finds a position among the spans", () => {
    const spans = mergeSpans([
      { start: 10, end: 20 },
      { start: 0, end: 2 },
      { start: 19, end: 25 },
      { start: 40, end: 41 },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 2 },
      { start: 10, end: 25 },
      { start: 40, end: 41 },
    ]);
    expect([0, 1, 2, 9, 10, 24, 25, 40, 41].map((position) => spansHave(spans, position))).toEqual([true, true, false, false, true, true, false, true, false]);
  });

  it("keeps a selection a right-click is in, and otherwise selects the row", () => {
    const state = selectPositionOnClick(selectPositionOnClick(EMPTY_SPANS, 1, plain), 4, range);
    expect(selectPositionForAction(state, 3)).toBe(state);
    expect(spansOf(selectPositionForAction(state, 7))).toEqual([[7, 8]]);
  });
});
