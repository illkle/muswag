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

  /** Runs a command from `app-contract.ts`; replies with an `AppCommandReply`. */
  "app:command": (name: string, args: readonly unknown[]) => unknown;
  /** Current value of a state from `app-contract.ts`. */
  "app:state": (name: string) => unknown;

  // Player payloads are `unknown` on both sides: main decodes commands and the renderer decodes
  // results against the schemas in player-contract.ts. The player's state reaches renderers through
  // the state mirror (player-state.ts).
  "player:command": (commandId: string, command: unknown) => unknown;
  "player:locate": () => unknown;
};

export type MuswagRendererIpc = {
  "app:state": [event: { name: string; value: unknown }];
  "appUpdate:state": [state: AppUpdateState];
};
