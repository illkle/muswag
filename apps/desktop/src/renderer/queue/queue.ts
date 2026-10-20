import type { QueueSourceRef } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { appCommand } from "#/data/app-command";
import { db } from "#/data/library";
import { collectionStore } from "#/data/stores";
import { queueStateFromRows, type QueueManagerState } from "#shared/queue-state";

/** The playback queue lives in main; these send it commands. */
export const QueueActions = {
  playSource: (ref: QueueSourceRef, key: string) => appCommand("queue:playSource", ref, key),
  /** Plays an occurrence the queue holds: a queued track, or one of those next in its source. */
  select: (key: string) => appCommand("queue:select", key),
  /** Starts the queue when the player holds nothing. */
  play: () => appCommand("queue:play"),
  enqueue: (songIds: readonly string[]) => appCommand("queue:enqueue", songIds),
  removeQueued: (key: string) => appCommand("queue:removeQueued", key),
  next: () => appCommand("queue:next"),
  previous: () => appCommand("queue:previous"),
};

/** The queue as main stores it in the mirrored queue tables, put together once per change for every reader. */
const queue = collectionStore([db.queueState, db.queueItems], () => queueStateFromRows(db.queueState.get(1), db.queueItems.toArray));

/** What `select` makes of the queue. The component re-renders only when that changes. */
export const useQueueSelector = <T>(select: (queue: QueueManagerState) => T): T => useSelector(queue, select);

export const useQueueManagerState = (): QueueManagerState => useQueueSelector((state) => state);

/**
 * The key of the occurrence playing, when the queue is playing through a source `isSource` accepts, so that a
 * list of that source marks its row. A list re-renders only when this changes, and not with every change to the queue.
 */
export const usePlayingKey = (isSource: (ref: QueueSourceRef) => boolean): string | null =>
  useQueueSelector((state) => (state.source && isSource(state.source.ref) && state.nowPlaying?.origin === "source" ? state.nowPlaying.key : null));
