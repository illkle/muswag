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

  /** Runs a command from `commands/app.ts`; replies with an `AppCommandReply`. */
  "app:command": (name: string, args: readonly unknown[]) => unknown;

  // Player payloads are `unknown` on both sides: main decodes commands and the renderer decodes
  // results against the schemas in commands/player.ts. The player's state reaches renderers through
  // the state mirror (state/player.ts).
  "player:command": (commandId: string, command: unknown) => unknown;
  "player:locate": () => unknown;
};

export type MuswagRendererIpc = {
  "appUpdate:state": [state: AppUpdateState];
};
