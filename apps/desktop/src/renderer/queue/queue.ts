import type { QueueSourceRef, Song } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";

import { appCommand } from "#/data/app-command";
import { db } from "#/data/library";
import { queueStateFromRows, type QueueManagerState } from "#shared/queue-state";

/** The playback queue lives in main; these send it commands. */
export const QueueActions = {
  playSource: (ref: QueueSourceRef, key: string) => appCommand("queue:playSource", ref, key),
  /** Plays an occurrence the queue holds: a queued track, or one of those next in its source. */
  select: (key: string) => appCommand("queue:select", key),
  /** Starts the queue when the player holds nothing. */
  play: () => appCommand("queue:play"),
  enqueue: (tracks: readonly Pick<Song, "id">[]) =>
    appCommand(
      "queue:enqueue",
      tracks.map(({ id }) => id),
    ),
  removeQueued: (key: string) => appCommand("queue:removeQueued", key),
  next: () => appCommand("queue:next"),
  previous: () => appCommand("queue:previous"),
};

/** The queue as main stores it in the mirrored queue tables. */
export function useQueueManagerState(): QueueManagerState {
  const { data: state } = useLiveQuery((q) => q.from({ state: db.queueState }).findOne());
  const { data: items } = useLiveQuery((q) => q.from({ item: db.queueItems }));
  return useMemo(() => queueStateFromRows(state, items ?? []), [state, items]);
}
