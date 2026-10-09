import { useEffect, useSyncExternalStore } from "react";

import { appState } from "#/data/state";
import { notifyFailure } from "#/lib/notify";

const unplayable = appState.unplayable;
const subscribe = (onChange: () => void) => {
  const subscription = unplayable.subscribeChanges(onChange);
  return () => subscription.unsubscribe();
};

/**
 * Whether main could not play the song when the queue last started it. A list marks such a row, so
 * that a track the queue moved on from can still be told once something else is playing.
 */
export const useSongIsUnplayable = (songId: string): boolean => useSyncExternalStore(subscribe, () => unplayable.has(songId));

/** Says so, while this is mounted, each time the queue moves on from a track it could not play. */
export function useSkippedTrackNotices(): void {
  useEffect(() => {
    // What was skipped before this window was there is marked in the lists, and not announced again.
    const since = Date.now();
    const subscription = unplayable.subscribeChanges((changes) => {
      for (const { type, value } of changes) {
        if (type !== "delete" && value.skipped && value.at >= since) notifyFailure(`“${value.title}” could not be played and was skipped.`);
      }
    });
    return () => subscription.unsubscribe();
  }, []);
}
