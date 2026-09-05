import type { CommandResult, PlayerSnapshot } from "./player-contract";

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

  "player:command": (commandId: string, command: unknown) => CommandResult;
  "player:subscribe": (subscriptionId: string) => PlayerSnapshot;
  "player:unsubscribe": (subscriptionId: string) => void;
  "player:ackSnapshot": (subscriptionId: string) => void;
  "player:getSnapshot": () => PlayerSnapshot;
  "player:setCredentials": (credentials: unknown) => CommandResult;
  "player:locate": () => CommandResult | null;
};

export type MuswagRendererIpc = {
  "appUpdate:state": [state: AppUpdateState];
  "player:snapshot": [event: { subscriptionId: string; snapshot: PlayerSnapshot }];
};
