import type { PlaybackItem } from "@muswag/shared";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export type { MpvInstallMethod, MpvInstallOption, MpvSource } from "./player-contract";
import type { MpvInstallMethod, MpvInstallOption, MpvSource } from "./player-contract";

export type MpvState =
  | { status: "checking" }
  | { status: "ready"; binaryPath: string; source: MpvSource; version: string }
  | { status: "missing"; checkedPaths: string[]; installOptions: readonly MpvInstallOption[]; reason?: string }
  | { status: "invalid"; binaryPath: string; source: MpvSource; reason: string; installOptions: readonly MpvInstallOption[] };

export type MpvInstallState = { status: "idle" } | { status: "running" | "succeeded" | "cancelled"; method: MpvInstallMethod } | { status: "failed"; error: string; method: MpvInstallMethod };

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
  epoch?: string;
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

export interface QueuePlayerPort {
  applyQueue(input: ApplyMpvQueueInput): Promise<void>;
  restartCurrent(): Promise<void>;
  stop(): Promise<void>;
  getState(): Promise<PlayerRuntimeState>;
  subscribe(listener: (state: PlayerRuntimeState) => void): () => void;
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

export function getMpvUnavailableReason(mpvState: MpvState): string | null {
  switch (mpvState.status) {
    case "ready":
      return null;
    case "checking":
      return "Looking for the mpv binary…";
    case "missing":
      return mpvState.reason ?? "mpv is not installed, or it is installed somewhere Muswag could not find.";
    case "invalid":
      return `mpv was found at ${mpvState.binaryPath} but it could not be run: ${mpvState.reason}`;
  }
}

export function getMpvInstallOptions(mpvState: MpvState): readonly MpvInstallOption[] {
  return mpvState.status === "missing" || mpvState.status === "invalid" ? mpvState.installOptions : [];
}
