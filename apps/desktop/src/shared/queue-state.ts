import type { NowPlaying, PlaybackItem, QueueItemRow, QueueSourceRef, QueueStateRow, SourceCursor, SourceItem, SourceWindow } from "@muswag/model";

/** Everything the window has materialised, in playback order. */
export function sourceWindowItems(window: SourceWindow): SourceItem[] {
  return [...window.previous, ...(window.current ? [window.current] : []), ...window.next];
}

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

/** The occurrence Play starts when the player holds none: the one playing, which the player has yet to load, or else the next. */
export function startTarget(state: QueueManagerState): PlaybackItem | undefined {
  return state.nowPlaying ?? nextTarget(state);
}

export function getQueueCanStart(state: QueueManagerState): boolean {
  return Boolean(startTarget(state));
}

/** The occurrence "previous" would move to. A user-queued track steps back into the source it interrupted. */
export function previousTarget(state: QueueManagerState): PlaybackItem | undefined {
  const source = state.source?.window;
  return (state.nowPlaying?.origin === "user" ? source?.current : undefined) ?? source?.previous.at(-1);
}

/** A queue with an occurrence playing. */
export type PlayingQueueState = QueueManagerState & { nowPlaying: NowPlaying };

/**
 * The queue once playback is on the occurrence `key` it holds: the one playing, a queued track, or one
 * in the window of the source. Queued tracks passed over on the way leave the queue, as they do when
 * stepped through one at a time, and one that was playing does not go back into it. `undefined` when the
 * queue does not hold `key`.
 */
export function queueStateAt(state: QueueManagerState, key: string): PlayingQueueState | undefined {
  if (state.nowPlaying?.key === key) return { ...state, nowPlaying: state.nowPlaying };
  const queued = state.userQueue.findIndex((item) => item.key === key);
  if (queued >= 0) return { nowPlaying: { ...state.userQueue[queued]!, origin: "user" }, userQueue: state.userQueue.slice(queued + 1), source: state.source };
  const source = state.source;
  const reached = source && sourceWindowItems(source.window).find((item) => item.key === key);
  if (!source || !reached) return undefined;
  return {
    nowPlaying: { key: reached.key, track: reached.track, origin: "source" },
    // The user queue plays before what follows in the source, so getting there passes all of it.
    userQueue: source.window.next.includes(reached) ? [] : state.userQueue,
    source: { ref: source.ref, window: windowAround({ type: "item", key: reached.key, offset: reached.offset }, sourceWindowItems(source.window), source.window.hasMore) },
  };
}

/** `items`, in playback order, as the window around `cursor`. A gap cursor has no current occurrence; what follows it starts at its offset. */
function windowAround(cursor: SourceCursor, items: readonly SourceItem[], hasMore: boolean): SourceWindow {
  return {
    cursor,
    previous: items.filter(({ offset }) => offset < cursor.offset),
    current: cursor.type === "item" ? (items.find(({ key }) => key === cursor.key) ?? null) : null,
    next: items.filter(({ offset }) => (cursor.type === "item" ? offset > cursor.offset : offset >= cursor.offset)),
    hasMore,
  };
}

// ---- Storage ----
// Main stores the queue in the mirrored `queue_items` and `queue_state` tables; the renderer reads it
// back from them. These convert between the two shapes. Where playback resumes after a restart is not
// part of it: only main needs that, and it changes all the time.

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

/** The single state row that stores `state`. */
export function queueStateRow(state: QueueManagerState): QueueStateRow {
  const source = state.source;
  return {
    id: 1,
    nowPlayingKey: state.nowPlaying?.key ?? null,
    nowPlayingOrigin: state.nowPlaying?.origin ?? null,
    source: source ? { ref: source.ref, cursor: source.window.cursor, hasMore: source.window.hasMore } : null,
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
  const items = ordered.filter(({ list }) => list === "source").map(({ key, track, position }): SourceItem => ({ key, track, offset: position }));
  return windowAround(source.cursor, items, source.hasMore);
}
