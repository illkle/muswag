import { useSelector } from "@tanstack/react-store";

import { playerState } from "#/data/state";
import { collectionStore, rowStore } from "#/data/stores";
import { useQueueSelector } from "#/queue/queue";
import type { BinaryState, InstallState, PlayerError } from "#shared/commands/player";
import { getQueueCanGoNext, getQueueCanGoPrevious, getQueueCanStart } from "#shared/queue-state";
import type { PlayerPositionRow, PlayerRow } from "#shared/state/player";

// ---- Rows ----
// Each player table has one row, keyed "player", except the install output. Each hook selects what it
// needs from them, so a component re-renders only when that changes: the position changes twice a second.

/** `undefined` until the state mirror has loaded. */
const playerRow = rowStore(playerState.player, "player");
const positionRow = rowStore(playerState.position, "player");

const usePlayer = <T>(select: (row: PlayerRow | undefined) => T): T => useSelector(playerRow, select);
const usePosition = <T>(select: (row: PlayerPositionRow | undefined) => T): T => useSelector(positionRow, select);

// ---- Player ----

export const usePlayerConnected = () => usePlayer((row) => row !== undefined);
export const usePlayerCurrentTrackId = () => usePlayer((row) => row?.item?.track.id ?? null);
export const usePlayerCurrentTrack = () => usePlayer((row) => row?.item?.track ?? null);
export const usePlayerStatus = () => usePlayer((row) => row?.status ?? "idle");
export const usePlayerBuffering = () => usePlayer((row) => row?.buffering ?? false);
export const usePlayerDuration = () => usePosition((row) => row?.durationSeconds ?? null);
export const usePlayerPositionSeconds = () => usePosition((row) => row?.positionSeconds ?? 0);
export const usePlayerMuted = () => usePlayer((row) => row?.muted ?? false);
export const usePlayerVolumePercent = () => usePlayer((row) => row?.volumePercent ?? 100);

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
  const started = usePosition((row) => (row?.positionSeconds ?? 0) > 0);
  const queueCanGoBack = useQueueSelector((queue) => getQueueCanGoPrevious(queue, started ? 1 : 0));
  return connected && queueCanGoBack;
}

// ---- mpv ----

const CHECKING: BinaryState = { _tag: "Checking" };
const INSTALL_IDLE: InstallState = { _tag: "Idle" };

export const usePlayerMpvBinary = (): BinaryState => usePlayer((row) => row?.binary ?? CHECKING);
export const usePlayerMpvInstall = (): InstallState => usePlayer((row) => row?.install ?? INSTALL_IDLE);

/** The output of the running or last mpv installation, oldest line first. Main keeps only its tail, so sorting it here is cheap. */
const installOutput = collectionStore([playerState.installOutput], () => playerState.installOutput.toArray.sort((left, right) => left.sequence - right.sequence).map(({ line }) => line));
export const usePlayerInstallOutput = (): string[] => useSelector(installOutput);
