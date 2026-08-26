import type { ApplyMpvQueueInput, MpvInstallMethod, MpvState, PlayerEvent, PlayerState } from "./player";
import type { SessionCredentials } from "@muswag/shared";

export type MpvInstallOutput = {
  line: string;
  stream: "stdout" | "stderr";
};

export type AppUpdateStatus = "disabled" | "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error";

export type AppUpdateState = {
  canCheck: boolean;
  currentVersion: string;
  error: string | null;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  progressPercent: number | null;
  status: AppUpdateStatus;
};

export type MuswagMainIpc = {
  "appUpdate:check": () => AppUpdateState;
  "appUpdate:getState": () => AppUpdateState;
  /** Quits and installs a downloaded update. Does nothing until the status is `ready`. */
  "appUpdate:install": () => void;

  "fs:write": (path: string, data: Uint8Array) => void;
  "fs:delete": (path: string) => void;

  "mpv:cancelInstall": () => void;
  "mpv:clearManualPath": () => MpvState;
  "mpv:install": (method: MpvInstallMethod) => MpvState;
  /** Opens a file picker so the user can point at an mpv binary. Returns the unchanged state when cancelled. */
  "mpv:locate": () => MpvState;
  "mpv:recheck": () => MpvState;
  "player:getState": () => PlayerState;
  "player:applyQueue": (input: ApplyMpvQueueInput) => void;
  "player:pause": () => void;
  "player:play": () => void;
  "player:restartCurrent": () => void;
  "player:stop": () => void;
  "player:seek": (positionSeconds: number) => void;
  "player:setCredentials": (credentials: SessionCredentials | null) => Promise<void>;
  "player:setMuted": (muted: boolean) => void;
  "player:setVolume": (volumePercent: number) => void;
  "player:toggle": () => void;
};

export type MuswagRendererIpc = {
  "appUpdate:state": [state: AppUpdateState];
  "mpv:installOutput": [output: MpvInstallOutput];
  "player:event": [event: PlayerEvent];
};
