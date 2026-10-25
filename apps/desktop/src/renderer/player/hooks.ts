import { useSelector } from "@tanstack/react-store";
import { useEffect, useState } from "react";

import { appState } from "#/data/app-state";
import { useQueueSelector } from "#/queue/queue";
import type { BinaryState, PlayerError } from "#shared/commands/player";
import { getQueueCanGoNext, getQueueCanGoPrevious, getQueueCanStart } from "#shared/queue-state";
import { positionAt, type PlayerPositionRow, type PlayerRow } from "#shared/state/player";

// ---- State ----
// What the player is doing, and where it is in the track, each `undefined` until main has published it.
// Each hook selects what it needs, so a component re-renders only when that changes.

const usePlayer = <T>(select: (row: PlayerRow | undefined) => T): T => useSelector(appState.player, select);
const usePosition = <T>(select: (row: PlayerPositionRow | undefined) => T): T => useSelector(appState.playerPosition, select);

// ---- Player ----

export const usePlayerConnected = () => usePlayer((row) => row !== undefined);
export const usePlayerCurrentTrackId = () => usePlayer((row) => row?.item?.track.id ?? null);
export const usePlayerCurrentTrack = () => usePlayer((row) => row?.item?.track ?? null);
export const usePlayerStatus = () => usePlayer((row) => row?.status ?? "idle");
export const usePlayerBuffering = () => usePlayer((row) => row?.buffering ?? false);
export const usePlayerDuration = () => usePosition((row) => row?.durationSeconds ?? null);
export const usePlayerMuted = () => usePlayer((row) => row?.muted ?? false);
export const usePlayerVolumePercent = () => usePlayer((row) => row?.volumePercent ?? 100);

/** A tenth of a second: as finely as the position is shown, so it re-renders no more often than this. */
const floorToTenth = (seconds: number) => Math.floor(seconds * 10) / 10;
/**
 * Where playback is. Main writes the position only when it jumps, so while the track plays it is moved
 * on here with the clock, frame by frame, up to the end of the track. It holds while paused or buffering.
 */
export function usePlayerPositionSeconds(): number {
  const row = usePosition((row) => row);
  // Only makes the component render again: the position itself is read off the clock as it does.
  const [, setShown] = useState(0);
  useEffect(() => {
    if (!row?.advancing) return;
    let frame = requestAnimationFrame(function tick() {
      setShown(floorToTenth(positionAt(row, Date.now())));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [row]);
  if (!row) return 0;
  return row.advancing ? floorToTenth(positionAt(row, Date.now())) : row.positionSeconds;
}

const DISCONNECTED: PlayerError = { message: "Playback disconnected. Reconnecting…", fix: null };
/**
 * What went wrong last with playback, and what the user can do about it. Main keeps it, and takes it
 * back when a track loads, when what it asks for is done, or when the user dismisses it.
 */
export const usePlayerError = (): PlayerError | null => usePlayer((row) => (row === undefined ? DISCONNECTED : row.error));

/**
 * Play waits only for a track to load: commands are run in order by main, so one in flight is no reason to hold it back.
 * With no track in the player it starts the queue, when the queue has one to start with.
 */
export const usePlayerCanPlay = () => {
  const queueCanStart = useQueueSelector(getQueueCanStart);
  return usePlayer((row) => row !== undefined && (row.item === null ? queueCanStart : row.status !== "loading"));
};
/** Seeking does not wait: main runs commands in order, and disabling the slider for every one of them made it flicker. */
export const usePlayerCanSeek = () => {
  const status = usePlayerStatus();
  const duration = usePlayerDuration();
  return (status === "playing" || status === "paused") && (duration ?? 0) > 0;
};

export function usePlayerCanGoForward() {
  const connected = usePlayerConnected();
  const queueCanGoNext = useQueueSelector(getQueueCanGoNext);
  return connected && queueCanGoNext;
}
export function usePlayerCanGoBack() {
  const connected = usePlayerConnected();
  // Only whether the track has started matters, not where it is, so the controls do not re-render with the position.
  // One that plays on has started, however near its start it was when main last wrote the position.
  const started = usePosition((row) => (row?.positionSeconds ?? 0) > 0 || (row?.advancing ?? false));
  const queueCanGoBack = useQueueSelector((queue) => getQueueCanGoPrevious(queue, started ? 1 : 0));
  return connected && queueCanGoBack;
}

// ---- mpv ----

const CHECKING: BinaryState = { _tag: "Checking" };

export const usePlayerMpvBinary = (): BinaryState => usePlayer((row) => row?.binary ?? CHECKING);
