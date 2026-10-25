// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { songRow } from "@muswag/model";

import type { Span } from "#/components/track-list/selection";
import type { TrackItem, TrackRows } from "#/components/track-list/types";
import { useKeySelection, useSpanSelection, useTrackListSelection } from "#/components/track-list/use-selection";

afterEach(cleanup);

const track = (key: string, unavailable = false): TrackItem => ({ type: "track", key, song: songRow({ id: `song-${key}`, title: key }), unavailable });
const plain = { toggle: false, range: false };

describe("selection by key", () => {
  const [a, b, c] = [track("a"), track("b"), track("c")];

  it("keeps the keyboard and the selection on their tracks when the tracks move", () => {
    const { result, rerender } = renderHook(({ tracks }) => useKeySelection(tracks), { initialProps: { tracks: [a, b, c] } });
    act(() => {
      result.current.moveCursor(0);
      result.current.select(0, plain);
    });

    rerender({ tracks: [b, c, a] });
    expect(result.current.cursor).toBe(2);
    expect([0, 1, 2].map(result.current.isSelected)).toEqual([false, false, true]);
  });

  it("acts on none of the tracks that have left, and on the keyboard's track nowhere once it has", () => {
    const { result, rerender } = renderHook(({ tracks }) => useKeySelection(tracks), { initialProps: { tracks: [a, b, c] } });
    act(() => {
      result.current.selectAll();
      result.current.moveCursor(1);
    });

    rerender({ tracks: [a, c] });
    expect(result.current.current().items).toEqual([a, c]);
    expect(result.current.cursor).toBe(-1);
    // Coming back to the list by keyboard does not move it to the first track in view.
    expect(result.current.hasCursor).toBe(true);
  });

  it("acts on a track outside the selection alone, and on nothing for a track that is not in the library", async () => {
    const missing = track("missing", true);
    const { result } = renderHook(() => useKeySelection([a, b, missing]));
    act(() => result.current.select(0, plain));

    expect(await result.current.from(1).songIds()).toEqual(["song-b"]);
    expect(result.current.from(2)).toMatchObject({ items: [missing], count: 0 });
    expect(result.current.from(0).items).toEqual([a]);
  });
});

describe("selection by position", () => {
  const rowsOf = (count: number, loaded: number): TrackRows => ({
    count,
    at: (position) => (position < loaded ? track(`s${position}`) : undefined),
    show: () => {},
    songIds: vi.fn(async (spans: readonly Span[]) => spans.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, index) => `song-s${start + index}`))),
  });

  it("asks for the song of a row it has not loaded, outside the selection", async () => {
    const rows = rowsOf(100, 5);
    const { result } = renderHook(() => useSpanSelection(rows));
    act(() => result.current.select(0, plain));

    const selection = result.current.from(50);
    expect(selection).toMatchObject({ items: [], count: 1 });
    expect(await selection.songIds()).toEqual(["song-s50"]);
    expect(rows.songIds).toHaveBeenCalledWith([{ start: 50, end: 51 }]);
  });

  it("keeps the keyboard on its position when the rows there change", () => {
    const { result, rerender } = renderHook(({ rows }) => useSpanSelection(rows), { initialProps: { rows: rowsOf(100, 5) } });
    act(() => result.current.moveCursor(3));

    rerender({ rows: rowsOf(100, 10) });
    expect(result.current.cursor).toBe(3);
  });
});

it("selects by position in a list of rows, and by key in a list of items", () => {
  const rows: TrackRows = { count: 10, at: () => undefined, show: () => {}, songIds: async () => [] };
  const { result, rerender } = renderHook(({ tracks, rows }) => useTrackListSelection(tracks, rows), { initialProps: { tracks: [] as TrackItem[], rows: rows as TrackRows | undefined } });
  act(() => result.current.selectAll());
  expect(result.current.current().count).toBe(10);

  rerender({ tracks: [track("a"), track("b")], rows: undefined });
  expect(result.current.current().count).toBe(0);
  act(() => result.current.selectAll());
  expect(result.current.current().count).toBe(2);
});
