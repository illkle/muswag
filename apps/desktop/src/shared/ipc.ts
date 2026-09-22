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

  // Player payloads are `unknown` on both sides: main decodes commands and the renderer decodes
  // snapshots/results against the schemas in player-contract.ts.
  "player:command": (commandId: string, command: unknown) => unknown;
  "player:subscribe": (subscriptionId: string) => unknown;
  "player:unsubscribe": (subscriptionId: string) => void;
  "player:ackSnapshot": (subscriptionId: string) => void;
  "player:getSnapshot": () => unknown;
  "player:setCredentials": (credentials: unknown) => unknown;
  "player:locate": () => unknown;
};

export type MuswagRendererIpc = {
  "appUpdate:state": [state: AppUpdateState];
  "player:snapshot": [event: { subscriptionId: string; snapshot: unknown }];
};
