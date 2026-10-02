import type { NowPlaying, PlaybackItem, QueueItemRow, QueueSourceRef, QueueStateRow } from "@muswag/model";

import { sourceWindowItems, type SourceItem, type SourceWindow } from "./queue-source";

/** What main's queue manager publishes: the occurrence playing, the user queue and the source around it. */
export type QueueManagerState = {
  nowPlaying: NowPlaying | null;
  userQueue: readonly PlaybackItem[];
  source: { ref: QueueSourceRef; window: SourceWindow } | null;
};

export const emptyQueueState = (): QueueManagerState => ({ nowPlaying: null, userQueue: [], source: null });

export function getQueueCanGoNext(state: QueueManagerState): boolean {
  return Boolean(nextTarget(state));
}

/** Previous restarts the occurrence playing once it has started, or steps back to the one before it. */
export function getQueueCanGoPrevious(state: QueueManagerState, positionSeconds: number): boolean {
  if (!state.nowPlaying) return false;
  return positionSeconds > 0 || Boolean(previousTarget(state));
}

/** The occurrence "next" would move to: the user queue always wins over the source. */
export function nextTarget(state: QueueManagerState): PlaybackItem | undefined {
  return state.userQueue[0] ?? state.source?.window.next[0];
}

/** The occurrence "previous" would move to. A user-queued track steps back into the source it interrupted. */
export function previousTarget(state: QueueManagerState): PlaybackItem | undefined {
  const source = state.source?.window;
  return (state.nowPlaying?.origin === "user" ? source?.current : undefined) ?? source?.previous.at(-1);
}

// ---- Storage ----
// Main stores the queue in the mirrored `queue_items` and `queue_state` tables; the renderer reads it
// back from them. These convert between the two shapes.

/** The occurrences that store `state`. The one playing gets a row of its own only when it is in neither list. */
export function queueItemRows(state: QueueManagerState): QueueItemRow[] {
  const rows: QueueItemRow[] = [
    ...(state.source ? sourceWindowItems(state.source.window).map((item): QueueItemRow => ({ key: item.key, list: "source", position: item.offset, track: item.track })) : []),
    ...state.userQueue.map((item, index): QueueItemRow => ({ key: item.key, list: "user", position: index, track: item.track })),
  ];
  const playing = state.nowPlaying;
  if (playing && !rows.some(({ key }) => key === playing.key)) rows.push({ key: playing.key, list: "now", position: 0, track: playing.track });
  return rows;
}

/** The single state row that stores `state`, resuming at `resumePositionSeconds`. */
export function queueStateRow(state: QueueManagerState, resumePositionSeconds: number): QueueStateRow {
  const source = state.source;
  return {
    id: 1,
    nowPlayingKey: state.nowPlaying?.key ?? null,
    nowPlayingOrigin: state.nowPlaying?.origin ?? null,
    source: source ? { ref: source.ref, cursor: source.window.cursor, revision: source.window.revision } : null,
    resumePositionSeconds,
  };
}

/** The queue that `state` and `items` store. */
export function queueStateFromRows(state: QueueStateRow | null | undefined, items: readonly QueueItemRow[]): QueueManagerState {
  if (!state) return emptyQueueState();
  const ordered = [...items].sort((left, right) => left.position - right.position);
  const playing = state.nowPlayingKey === null ? undefined : items.find(({ key }) => key === state.nowPlayingKey);
  return {
    nowPlaying: playing && state.nowPlayingOrigin ? { key: playing.key, track: playing.track, origin: state.nowPlayingOrigin } : null,
    userQueue: ordered.filter(({ list }) => list === "user").map(({ key, track }) => ({ key, track })),
    source: state.source ? { ref: state.source.ref, window: windowFromRows(state.source, ordered) } : null,
  };
}

function windowFromRows(source: NonNullable<QueueStateRow["source"]>, ordered: readonly QueueItemRow[]): SourceWindow {
  const { cursor, revision } = source;
  const items = ordered.filter(({ list }) => list === "source").map(({ key, track, position }): SourceItem => ({ key, track, offset: position }));
  // A gap cursor has no current occurrence; what follows it starts at its offset.
  const current = cursor.type === "item" ? (items.find(({ key }) => key === cursor.key) ?? null) : null;
  return {
    revision,
    cursor,
    previous: items.filter(({ offset }) => offset < cursor.offset),
    current,
    next: items.filter(({ offset }) => (cursor.type === "item" ? offset > cursor.offset : offset >= cursor.offset)),
  };
}
