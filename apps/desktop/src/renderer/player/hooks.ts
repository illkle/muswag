import { useLiveQuery } from "@tanstack/react-db";
import { useStore } from "@tanstack/react-store";
import { useMemo } from "react";

import { playerState } from "#/data/state";
import { commandIssue } from "#/player/commands";
import { useQueueManagerState } from "#/queue/queue";
import type { BinaryState, InstallState } from "#shared/commands/player";
import { getQueueCanGoNext, getQueueCanGoPrevious } from "#shared/queue-state";
import { playerStatus, type PlaybackState, type PlayerStatus } from "#shared/state/player";

// ---- Rows ----
// Each player table has one row, keyed "player", except issues and install output.

/** `undefined` until the state mirror has loaded. */
const usePlayerRow = () => useLiveQuery((q) => q.from({ player: playerState.player }).findOne()).data;
const usePositionRow = () => useLiveQuery((q) => q.from({ position: playerState.position }).findOne()).data;
const useLatestIssue = () =>
  useLiveQuery((q) =>
    q
      .from({ issue: playerState.issues })
      .orderBy(({ issue }) => issue.order, "desc")
      .findOne(),
  ).data;

const statusOf = (playback: PlaybackState | undefined): PlayerStatus => (playback ? playerStatus(playback) : "idle");
const itemOf = (playback: PlaybackState | undefined) => (playback && playback._tag !== "Idle" ? playback.item : null);

// ---- Player ----

export const usePlayerConnected = () => usePlayerRow() !== undefined;
export const usePlayerCurrentTrackId = () => itemOf(usePlayerRow()?.playback)?.track.id ?? null;
export const usePlayerCurrentTrack = () => itemOf(usePlayerRow()?.playback)?.track ?? null;
export const usePlayerStatus = () => statusOf(usePlayerRow()?.playback);
export const usePlayerBuffering = () => {
  const playback = usePlayerRow()?.playback;
  return playback?._tag === "Playing" && playback.buffering;
};
export const usePlayerDuration = () => usePositionRow()?.durationSeconds ?? null;
export const usePlayerPositionSeconds = () => usePositionRow()?.positionSeconds ?? 0;
export const usePlayerMuted = () => usePlayerRow()?.muted ?? false;
export const usePlayerVolumePercent = () => usePlayerRow()?.volumePercent ?? 100;

/** The issue to show: a rejected command's, or else the latest the player recorded. */
export const usePlayerIssue = () => {
  const rejected = useStore(commandIssue);
  const latest = useLatestIssue();
  return rejected ?? latest ?? null;
};
/** What that issue says. A failure of playback is among the player's issues, so dismissing it clears this as well. */
export const usePlayerError = () => {
  const connected = usePlayerConnected();
  const issue = usePlayerIssue();
  if (!connected) return "Playback disconnected. Reconnecting…";
  return issue?.message ?? null;
};

/** Play and pause wait while main is still working on a command. */
export const usePlayerCanPlay = () => {
  const row = usePlayerRow();
  return row !== undefined && !row.pending && itemOf(row.playback) !== null && statusOf(row.playback) !== "loading";
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

export const usePlayerMpvAvailable = () => usePlayerRow()?.binary._tag === "Ready";
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
