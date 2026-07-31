import type { Song } from "@muswag/shared";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export type PlayerQueueItem = Song;

export type PlayerQueueContext = { type: "playlist"; playlistId: string; entryIds: string[] } | { type: "album"; albumId: string } | null;

export interface PlayQueueInput {
  queue: PlayerQueueItem[];
  startIndex: number;
  context?: PlayerQueueContext;
}

/** How the mpv binary in use was found. */
export type MpvSource = "env" | "manual" | "cache" | "path" | "well-known" | "login-shell";

export type MpvInstallMethod = "brew" | "scoop" | "choco" | "apt" | "dnf" | "pacman" | "zypper" | "flatpak";

export interface MpvInstallOption {
  /** Command line shown to the user. */
  command: string;
  /** True when the app can run the command itself without a terminal or elevation. */
  automatic: boolean;
  method: MpvInstallMethod;
  /** Extra context shown when `automatic` is false. */
  note: string | null;
  /** Documentation link for the package manager, when the manager itself is missing. */
  url: string | null;
}

export type MpvState =
  | { status: "checking" }
  | { status: "ready"; binaryPath: string; source: MpvSource; version: string }
  | { status: "missing"; checkedPaths: string[]; installOptions: MpvInstallOption[] }
  | { status: "invalid"; binaryPath: string; source: MpvSource; reason: string; installOptions: MpvInstallOption[] };

export type MpvInstallState =
  | { status: "idle" }
  | { status: "running"; command: string; method: MpvInstallMethod }
  | { status: "failed"; command: string; error: string; method: MpvInstallMethod }
  | { status: "succeeded"; command: string; method: MpvInstallMethod };

export interface PlayerMetaState {
  mpv: MpvState;
  mpvInstall: MpvInstallState;
}

export interface PlayerQueueState {
  queue: string[];
  currentIndex: number;
  currentTrackId: string | null;
  context: PlayerQueueContext;
}

export interface PlayerNowPlayingState {
  status: PlayerStatus;
  positionSeconds: number;
  durationSeconds: number | null;
  error: string | null;
}

export interface PlayerVolumeState {
  volumePercent: number;
  muted: boolean;
}

export interface PlayerState {
  meta: PlayerMetaState;
  queue: PlayerQueueState;
  nowPlaying: PlayerNowPlayingState;
  volume: PlayerVolumeState;
}

export type PlayerEvent =
  | {
      type: "meta";
      state: PlayerMetaState;
    }
  | {
      type: "queue";
      state: PlayerQueueState;
    }
  | {
      type: "nowPlaying";
      state: PlayerNowPlayingState;
    }
  | {
      type: "volume";
      state: PlayerVolumeState;
    };

export function createDefaultPlayerMetaState(): PlayerMetaState {
  return {
    mpv: { status: "checking" },
    mpvInstall: { status: "idle" },
  };
}

export function createDefaultPlayerQueueState(): PlayerQueueState {
  return {
    queue: [],
    currentIndex: -1,
    currentTrackId: null,
    context: null,
  };
}

export function createDefaultPlayerNowPlayingState(): PlayerNowPlayingState {
  return {
    status: "idle",
    positionSeconds: 0,
    durationSeconds: null,
    error: null,
  };
}

export function createDefaultPlayerVolumeState(): PlayerVolumeState {
  return {
    volumePercent: 100,
    muted: false,
  };
}

export function createDefaultPlayerState(): PlayerState {
  return {
    meta: createDefaultPlayerMetaState(),
    queue: createDefaultPlayerQueueState(),
    nowPlaying: createDefaultPlayerNowPlayingState(),
    volume: createDefaultPlayerVolumeState(),
  };
}

export function getMpvAvailable(metaState: PlayerMetaState): boolean {
  return metaState.mpv.status === "ready";
}

/** Human readable reason mpv cannot be used, or null when it can. */
export function getMpvUnavailableReason(mpvState: MpvState): string | null {
  switch (mpvState.status) {
    case "ready":
      return null;
    case "checking":
      return "Looking for the mpv binary…";
    case "missing":
      return "mpv is not installed, or it is installed somewhere Muswag could not find.";
    case "invalid":
      return `mpv was found at ${mpvState.binaryPath} but it could not be run: ${mpvState.reason}`;
  }
}

export function getMpvInstallOptions(mpvState: MpvState): MpvInstallOption[] {
  return mpvState.status === "missing" || mpvState.status === "invalid" ? mpvState.installOptions : [];
}

export function isSameMpvState(nextState: MpvState, previousState: MpvState): boolean {
  if (nextState.status !== previousState.status) {
    return false;
  }

  if (nextState.status === "ready" && previousState.status === "ready") {
    return (
      nextState.binaryPath === previousState.binaryPath &&
      nextState.source === previousState.source &&
      nextState.version === previousState.version
    );
  }

  if (nextState.status === "missing" && previousState.status === "missing") {
    return (
      isSameStringList(nextState.checkedPaths, previousState.checkedPaths) &&
      isSameInstallOptions(nextState.installOptions, previousState.installOptions)
    );
  }

  if (nextState.status === "invalid" && previousState.status === "invalid") {
    return (
      nextState.binaryPath === previousState.binaryPath &&
      nextState.reason === previousState.reason &&
      nextState.source === previousState.source &&
      isSameInstallOptions(nextState.installOptions, previousState.installOptions)
    );
  }

  return true;
}

export function isSameMpvInstallState(nextState: MpvInstallState, previousState: MpvInstallState): boolean {
  if (nextState.status !== previousState.status) {
    return false;
  }

  if (nextState.status === "idle" || previousState.status === "idle") {
    return true;
  }

  return (
    nextState.command === previousState.command &&
    nextState.method === previousState.method &&
    (nextState.status === "failed" && previousState.status === "failed" ? nextState.error === previousState.error : true)
  );
}

export function isSamePlayerMetaState(nextState: PlayerMetaState, previousState: PlayerMetaState): boolean {
  return isSameMpvState(nextState.mpv, previousState.mpv) && isSameMpvInstallState(nextState.mpvInstall, previousState.mpvInstall);
}

function isSameStringList(nextList: string[], previousList: string[]): boolean {
  return nextList.length === previousList.length && nextList.every((value, index) => value === previousList[index]);
}

function isSameInstallOptions(nextOptions: MpvInstallOption[], previousOptions: MpvInstallOption[]): boolean {
  return (
    nextOptions.length === previousOptions.length &&
    nextOptions.every((option, index) => {
      const previousOption = previousOptions[index];
      return (
        previousOption !== undefined &&
        option.automatic === previousOption.automatic &&
        option.command === previousOption.command &&
        option.method === previousOption.method &&
        option.note === previousOption.note &&
        option.url === previousOption.url
      );
    })
  );
}

export function getPlayerCanPlay(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && nowPlayingState.status !== "loading";
}

export function getPlayerCanGoForward(queueState: PlayerQueueState): boolean {
  return queueState.currentTrackId !== null && queueState.currentIndex >= 0 && queueState.currentIndex < queueState.queue.length - 1;
}

export function getPlayerCanGoBack(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && (queueState.currentIndex > 0 || nowPlayingState.positionSeconds > 0);
}

export function getPlayerCanSeek(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && (nowPlayingState.durationSeconds ?? 0) > 0;
}
