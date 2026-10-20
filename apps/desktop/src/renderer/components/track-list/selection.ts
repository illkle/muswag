/** Which rows of a track list are selected. `anchor` is the row a shift-click extends from. */
export type SelectionState = {
  readonly keys: ReadonlySet<string>;
  readonly anchor: string | null;
};

export const EMPTY_SELECTION: SelectionState = { keys: new Set(), anchor: null };

export const selectOnly = (key: string): SelectionState => ({ keys: new Set([key]), anchor: key });

export const selectAll = (order: readonly string[]): SelectionState => ({ keys: new Set(order), anchor: order[0] ?? null });

export function toggleSelected(state: SelectionState, key: string): SelectionState {
  const keys = new Set(state.keys);
  if (!keys.delete(key)) keys.add(key);
  return { keys, anchor: key };
}

/** Selects the rows from the anchor to `key`, where `order` is the keys of the list from top to bottom. */
export function selectRange(state: SelectionState, order: readonly string[], key: string): SelectionState {
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
  const to = order.indexOf(key);
  if (from === -1 || to === -1) return selectOnly(key);
  return { keys: new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)), anchor: state.anchor };
}

/** A click on a row: alone it selects only that row, `toggle` adds or removes it, `range` extends from the anchor. */
export function selectOnClick(state: SelectionState, order: readonly string[], key: string, modifiers: { toggle: boolean; range: boolean }): SelectionState {
  if (modifiers.range) return selectRange(state, order, key);
  if (modifiers.toggle) return toggleSelected(state, key);
  return selectOnly(key);
}

/**
 * A gesture that acts on the selection, such as a right-click or the start of a drag: it keeps a
 * selection the row is part of and otherwise selects only that row.
 */
export const selectForAction = (state: SelectionState, key: string): SelectionState => (state.keys.has(key) ? state : selectOnly(key));

// ---- By position ----
// A list that holds only the rows in view, such as the songs page, selects by position: its keys are not
// all known, and a selection of the whole library would be a key for every song. A selection is a few
// spans of positions however many rows it covers.

/** Positions from `start` up to `end`, which is not included. */
export type Span = { readonly start: number; readonly end: number };

/** Which positions of a list are selected: spans in order that neither overlap nor touch. `anchor` is the position a shift-click extends from. */
export type SpanSelection = {
  readonly spans: readonly Span[];
  readonly anchor: number | null;
};

export const EMPTY_SPANS: SpanSelection = { spans: [], anchor: null };

/** `spans` in order, with those that overlap or touch made one. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(({ start, end }) => end > start).sort((left, right) => left.start - right.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    else merged.push(span);
  }
  return merged;
}

/** Whether `position` is in one of `spans`, which are in order. */
export function spansHave(spans: readonly Span[], position: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle]!;
    if (position < span.start) high = middle - 1;
    else if (position >= span.end) low = middle + 1;
    else return true;
  }
  return false;
}

/** How many positions `spans` cover. */
export const spansSize = (spans: readonly Span[]) => spans.reduce((size, { start, end }) => size + end - start, 0);

export const selectPositionOnly = (position: number): SpanSelection => ({ spans: [{ start: position, end: position + 1 }], anchor: position });

export const selectAllPositions = (count: number): SpanSelection => ({ spans: count > 0 ? [{ start: 0, end: count }] : [], anchor: count > 0 ? 0 : null });

export function togglePosition(state: SpanSelection, position: number): SpanSelection {
  if (!spansHave(state.spans, position)) return { spans: mergeSpans([...state.spans, { start: position, end: position + 1 }]), anchor: position };
  const spans = state.spans.flatMap((span) =>
    position < span.start || position >= span.end
      ? [span]
      : [
          { start: span.start, end: position },
          { start: position + 1, end: span.end },
        ].filter(({ start, end }) => end > start),
  );
  return { spans, anchor: position };
}

/** A click on the row at `position`, as `selectOnClick` is for keys. A range is from the anchor to the row, in place of what was selected. */
export function selectPositionOnClick(state: SpanSelection, position: number, modifiers: { toggle: boolean; range: boolean }): SpanSelection {
  if (modifiers.range && state.anchor !== null) return { spans: [{ start: Math.min(state.anchor, position), end: Math.max(state.anchor, position) + 1 }], anchor: state.anchor };
  if (modifiers.range || !modifiers.toggle) return selectPositionOnly(position);
  return togglePosition(state, position);
}

/** As `selectForAction`: a selection the row is part of stays, and otherwise the row alone is selected. */
export const selectPositionForAction = (state: SpanSelection, position: number): SpanSelection => (spansHave(state.spans, position) ? state : selectPositionOnly(position));
