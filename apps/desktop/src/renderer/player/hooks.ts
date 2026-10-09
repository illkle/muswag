import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";

import { playerState } from "#/data/state";
import { useQueueManagerState } from "#/queue/queue";
import type { BinaryState, InstallState, PlayerError } from "#shared/commands/player";
import { getQueueCanGoNext, getQueueCanGoPrevious, getQueueCanStart } from "#shared/queue-state";

// ---- Rows ----
// Each player table has one row, keyed "player", except the install output.

/** `undefined` until the state mirror has loaded. */
const usePlayerRow = () => useLiveQuery((q) => q.from({ player: playerState.player }).findOne()).data;
const usePositionRow = () => useLiveQuery((q) => q.from({ position: playerState.position }).findOne()).data;

// ---- Player ----

export const usePlayerConnected = () => usePlayerRow() !== undefined;
export const usePlayerCurrentTrackId = () => usePlayerRow()?.item?.track.id ?? null;
export const usePlayerCurrentTrack = () => usePlayerRow()?.item?.track ?? null;
export const usePlayerStatus = () => usePlayerRow()?.status ?? "idle";
export const usePlayerBuffering = () => usePlayerRow()?.buffering ?? false;
export const usePlayerDuration = () => usePositionRow()?.durationSeconds ?? null;
export const usePlayerPositionSeconds = () => usePositionRow()?.positionSeconds ?? 0;
export const usePlayerMuted = () => usePlayerRow()?.muted ?? false;
export const usePlayerVolumePercent = () => usePlayerRow()?.volumePercent ?? 100;

const DISCONNECTED: PlayerError = { message: "Playback disconnected. Reconnecting…", fix: null };
/**
 * What went wrong last with playback, and what the user can do about it. Main keeps it, and takes it
 * back when a track loads, when what it asks for is done, or when the user dismisses it.
 */
export const usePlayerError = (): PlayerError | null => {
  const row = usePlayerRow();
  return row === undefined ? DISCONNECTED : row.error;
};

/**
 * Play waits only for a track to load: commands are run in order by main, so one in flight is no reason to hold it back.
 * With no track in the player it starts the queue, when the queue has one to start with.
 */
export const usePlayerCanPlay = () => {
  const row = usePlayerRow();
  const queue = useQueueManagerState();
  if (row === undefined) return false;
  if (row.item === null) return getQueueCanStart(queue);
  return row.status !== "loading";
};
/** Seeking does not wait: main runs commands in order, and disabling the slider for every one of them made it flicker. */
export const usePlayerCanSeek = () => {
  const status = usePlayerStatus();
  const duration = usePlayerDuration();
  return (status === "playing" || status === "paused") && (duration ?? 0) > 0;
};

export function usePlayerCanGoForward() {
  const connected = usePlayerConnected();
  const queue = useQueueManagerState();
  return connected && getQueueCanGoNext(queue);
}
export function usePlayerCanGoBack() {
  const connected = usePlayerConnected();
  const queue = useQueueManagerState();
  const positionSeconds = usePlayerPositionSeconds();
  return connected && getQueueCanGoPrevious(queue, positionSeconds);
}

// ---- mpv ----

const CHECKING: BinaryState = { _tag: "Checking" };
const INSTALL_IDLE: InstallState = { _tag: "Idle" };

export const usePlayerMpvBinary = (): BinaryState => usePlayerRow()?.binary ?? CHECKING;
export const usePlayerMpvInstall = (): InstallState => usePlayerRow()?.install ?? INSTALL_IDLE;
/** The output of the running or last mpv installation, oldest line first. */
export const usePlayerInstallOutput = () => {
  const { data } = useLiveQuery((q) =>
    q
      .from({ output: playerState.installOutput })
      .orderBy(({ output }) => output.sequence)
      .select(({ output }) => ({ id: output.id, line: output.line })),
  );
  return useMemo(() => (data ?? []).map(({ line }) => line), [data]);
};
