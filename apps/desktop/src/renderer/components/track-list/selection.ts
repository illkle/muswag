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
