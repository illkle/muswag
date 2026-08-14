import type { PlaybackItem } from "@muswag/shared";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

/** How the mpv binary in use was found. */
export type MpvSource = "env" | "manual" | "cache" | "path" | "well-known" | "login-shell";

export type MpvInstallMethod = "brew" | "winget" | "scoop" | "choco" | "apt" | "dnf" | "pacman" | "zypper" | "flatpak";

export interface MpvInstallOption {
  command: string;
  automatic: boolean;
  method: MpvInstallMethod;
  note: string | null;
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

export type MpvQueueSnapshot = {
  items: readonly PlaybackItem[];
};

export type ApplyMpvQueueInput = {
  snapshot: MpvQueueSnapshot;
  select?: {
    key: string;
    play: boolean;
    positionSeconds?: number;
  };
};

export type PlayerRuntimeState = {
  sequence: number;
  current: PlaybackItem | null;
  status: PlayerStatus;
  positionSeconds: number;
  durationSeconds: number | null;
  paused: boolean;
  error: string | null;
  volumePercent: number;
  muted: boolean;
};

export type PlayerState = {
  meta: PlayerMetaState;
  runtime: PlayerRuntimeState;
};

export type PlayerEvent = { type: "meta"; state: PlayerMetaState } | { type: "runtime"; state: PlayerRuntimeState };

export interface QueuePlayerPort {
  applyQueue(input: ApplyMpvQueueInput): Promise<void>;
  restartCurrent(): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<PlayerRuntimeState>;
  subscribe(listener: (state: PlayerRuntimeState) => void): () => void;
}

export function createDefaultPlayerMetaState(): PlayerMetaState {
  return { mpv: { status: "checking" }, mpvInstall: { status: "idle" } };
}

export function createDefaultPlayerRuntimeState(): PlayerRuntimeState {
  return {
    sequence: 0,
    current: null,
    status: "idle",
    positionSeconds: 0,
    durationSeconds: null,
    paused: false,
    error: null,
    volumePercent: 100,
    muted: false,
  };
}

export function createDefaultPlayerState(): PlayerState {
  return { meta: createDefaultPlayerMetaState(), runtime: createDefaultPlayerRuntimeState() };
}

export function getMpvAvailable(metaState: PlayerMetaState): boolean {
  return metaState.mpv.status === "ready";
}

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

/** Both halves are small, flat, plain-data states, so a serialised compare is enough. */
export function isSamePlayerMetaState(next: PlayerMetaState, previous: PlayerMetaState): boolean {
  return JSON.stringify(next) === JSON.stringify(previous);
}
