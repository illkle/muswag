import type { NowPlaying, PlaybackItem, QueueSourceRef } from "@muswag/model";

import type { PlayerRuntimeState } from "./player";
import type { SourceWindow } from "./queue-source";

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

export function getQueueCanGoPrevious(state: QueueManagerState, runtime: PlayerRuntimeState | null): boolean {
  if (!state.nowPlaying) return false;
  return (runtime?.positionSeconds ?? 0) > 0 || Boolean(previousTarget(state));
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
