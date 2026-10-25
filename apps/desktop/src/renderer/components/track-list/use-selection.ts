import { useState } from "react";

import {
  EMPTY_SELECTION,
  EMPTY_SPANS,
  selectAll,
  selectAllPositions,
  selectForAction,
  selectOnClick,
  selectPositionForAction,
  selectPositionOnClick,
  spansHave,
  spansSize,
  togglePosition,
  toggleSelected,
  type SelectionState,
  type SpanSelection,
} from "#/components/track-list/selection";
import type { TrackItem, TrackRows, TrackSelection } from "#/components/track-list/types";

/**
 * Which tracks of a list are selected, and the track the keyboard is on, both by where a track is among
 * the tracks of the list. A row that was clicked is where the keyboard goes on from.
 */
export type TrackListSelection = {
  isSelected: (position: number) => boolean;
  /** A click on the track at `position`: alone it selects only that track, `toggle` adds or removes it, `range` extends from the anchor. */
  select: (position: number, modifiers: { toggle: boolean; range: boolean }) => void;
  /** Adds the track at `position` to the selection, or takes it out. */
  toggle: (position: number) => void;
  /** A gesture that acts on the selection, such as a right-click: it keeps a selection the track is part of and otherwise selects only that track. */
  selectForAction: (position: number) => void;
  selectAll: () => void;
  clear: () => void;
  /** What the menu acts on, read only when it opens. */
  current: () => TrackSelection;
  /** What a gesture on the track at `position` acts on: the selection when the track is part of it, and otherwise the track alone. */
  from: (position: number) => TrackSelection;
  /** Where the track the keyboard is on is, or -1 when it is on none. */
  cursor: number;
  /** Whether the keyboard has been put on a track, even one that has left the list since. */
  hasCursor: boolean;
  moveCursor: (position: number) => void;
};

/** A gesture on a track outside the selection acts on that track alone. */
const alone = (item: TrackItem): TrackSelection => ({ items: [item], count: item.unavailable ? 0 : 1, songIds: () => Promise.resolve(item.unavailable ? [] : [item.song.id]) });

/** The selection of a list of items, `tracks` being its tracks in order. It is by key, which holds wherever its rows move. */
export function useKeySelection(tracks: readonly TrackItem[]): TrackListSelection {
  const [selectionState, setSelectionState] = useState(EMPTY_SELECTION);
  // The keyboard follows the track it is on by its key.
  const [cursor, setCursor] = useState<{ position: number; key: string | null } | null>(null);

  /** The keys of the tracks in order, which only clicks and keys need, so they are not kept between them. */
  const trackKeys = () => tracks.map(({ key }) => key);
  /** Changes the selection by the key of the track at `position`. */
  const withKeyAt = (position: number, change: (state: SelectionState, key: string) => SelectionState) => {
    const key = tracks[position]?.key;
    if (key !== undefined) setSelectionState((state) => change(state, key));
  };
  const isSelected = (position: number) => {
    const item = tracks[position];
    return item !== undefined && selectionState.keys.has(item.key);
  };
  const current = (): TrackSelection => {
    // Read from the rows that are there now, so keys of rows that have left the list select nothing.
    const selected = tracks.filter(({ key }) => selectionState.keys.has(key));
    const ids = selected.filter(({ unavailable }) => !unavailable).map(({ song }) => song.id);
    return { items: selected, count: ids.length, songIds: () => Promise.resolve(ids) };
  };

  return {
    isSelected,
    select: (position, modifiers) => withKeyAt(position, (state, key) => selectOnClick(state, trackKeys(), key, modifiers)),
    toggle: (position) => withKeyAt(position, toggleSelected),
    selectForAction: (position) => withKeyAt(position, selectForAction),
    selectAll: () => setSelectionState(selectAll(trackKeys())),
    clear: () => setSelectionState(EMPTY_SELECTION),
    current,
    // Only a track the list holds is gestured on.
    from: (position) => (isSelected(position) ? current() : alone(tracks[position]!)),
    cursor: cursor === null ? -1 : cursor.key === null ? cursor.position : tracks.findIndex(({ key }) => key === cursor.key),
    hasCursor: cursor !== null,
    moveCursor: (position) => setCursor({ position, key: tracks[position]?.key ?? null }),
  };
}

/**
 * The selection of a list of `TrackRows`, which does not know every key, so it is by position. Positions
 * move when rows come or go, so it starts over then.
 */
export function useSpanSelection(rows: TrackRows): TrackListSelection {
  const { count } = rows;
  // The keyboard keeps to its position.
  const [cursor, setCursor] = useState<number | null>(null);
  const [spanState, setSpanState] = useState<SpanSelection>(EMPTY_SPANS);
  const [spansFor, setSpansFor] = useState(count);
  if (spansFor !== count) {
    setSpansFor(count);
    setSpanState(EMPTY_SPANS);
    // A position the keyboard was on may be past the end now, or another song's.
    setCursor(null);
  }

  const isSelected = (position: number) => spansHave(spanState.spans, position);
  const current = (): TrackSelection => {
    const { spans } = spanState;
    const held: TrackItem[] = [];
    for (const { start, end } of spans) {
      for (let position = start; position < end; position++) {
        const item = rows.at(position);
        if (item) held.push(item);
      }
    }
    const count = spansSize(spans);
    // Main reads positions as the library is now, which a change may have moved since the rows on
    // screen were read; a selection of those rows only is what they show.
    if (held.length === count) {
      const ids = held.map(({ song }) => song.id);
      return { items: held, count, songIds: () => Promise.resolve(ids) };
    }
    return { items: held, count, songIds: () => rows.songIds(spans) };
  };

  return {
    isSelected,
    select: (position, modifiers) => setSpanState((state) => selectPositionOnClick(state, position, modifiers)),
    toggle: (position) => setSpanState((state) => togglePosition(state, position)),
    selectForAction: (position) => setSpanState((state) => selectPositionForAction(state, position)),
    selectAll: () => setSpanState(selectAllPositions(rows.count)),
    clear: () => setSpanState(EMPTY_SPANS),
    current,
    from: (position) => {
      if (isSelected(position)) return current();
      const item = rows.at(position);
      return item ? alone(item) : { items: [], count: 1, songIds: () => rows.songIds([{ start: position, end: position + 1 }]) };
    },
    cursor: cursor ?? -1,
    hasCursor: cursor !== null,
    moveCursor: setCursor,
  };
}

const NO_ROWS: TrackRows = { count: 0, at: () => undefined, show: () => {}, songIds: () => Promise.resolve([]) };

/**
 * The selection of a list of items, whose tracks are `tracks`, or of a list of `rows`. Both are kept
 * whichever the list is, so that it calls the same hooks on every render; a list is one or the other
 * for as long as it is drawn, and one that changed would start over with its keyboard on no track.
 */
export function useTrackListSelection(tracks: readonly TrackItem[], rows: TrackRows | undefined): TrackListSelection {
  const byKey = useKeySelection(tracks);
  const byPosition = useSpanSelection(rows ?? NO_ROWS);
  return rows ? byPosition : byKey;
}
