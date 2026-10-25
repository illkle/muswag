import { useSelector } from "@tanstack/react-store";
import { useEffect } from "react";

import { appState } from "#/data/app-state";
import { notifyFailure } from "#/lib/notify";
import type { UnplayableTrack } from "#shared/state/queue";

const NONE: ReadonlyArray<UnplayableTrack> = [];

/**
 * Whether main could not play the song when the queue last started it. A list marks such a row, so
 * that a track the queue moved on from can still be told once something else is playing.
 */
export const useSongIsUnplayable = (songId: string): boolean => useSelector(appState.unplayable, (tracks) => (tracks ?? NONE).some(({ id }) => id === songId));

/** Says so, while this is mounted, each time the queue moves on from a track it could not play. */
export function useSkippedTrackNotices(): void {
  useEffect(() => {
    // What was skipped before this window was there is marked in the lists, and not announced again.
    let announced = Date.now();
    const subscription = appState.unplayable.subscribe((tracks) => {
      const latest = announced;
      for (const track of tracks ?? NONE) {
        if (!track.skipped || track.at <= latest) continue;
        notifyFailure(`“${track.title}” could not be played and was skipped.`);
        announced = Math.max(announced, track.at);
      }
    });
    return () => subscription.unsubscribe();
  }, []);
}
