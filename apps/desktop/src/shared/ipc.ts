import type { AppStateSnapshot } from "./state/app-state";

/** What a renderer can ask of main, by channel. */
export type MuswagMainIpc = {
  /**
   * Starts sending this renderer the events of `EVENT_CHANNELS`, and replies with main's state as of
   * then (`state/app-state.ts`). A renderer asks once, before anything else.
   */
  "app:connect": () => AppStateSnapshot;

  /** Checks for an update now. The outcome arrives in the update state (`state/app-update.ts`). */
  "appUpdate:check": () => void;
  /** Quits and installs a downloaded update. Does nothing until the status is `ready`. */
  "appUpdate:install": () => void;

  /** Runs a command from `commands/app.ts`; replies with an `AppCommandReply`. */
  "app:command": (name: string, args: readonly unknown[]) => unknown;

  // Player payloads are `unknown` on both sides: main decodes a renderer's commands and the renderer
  // decodes results against the schemas in commands/player.ts. The player's state reaches renderers
  // as app state (state/player.ts).
  "player:command": (command: unknown) => unknown;
  "player:locate": () => unknown;
};

/** What main sends a connected renderer, by channel. */
export type MuswagRendererEvents = {
  /** A value of main's state changed: an `AppStateUpdate`. */
  "app:state": unknown;
  /** Writes changed rows of the library: a `LibraryChangedEvent`. */
  "library:changed": unknown;
};

/** Every channel the renderer uses, which is all the preload lets through. */
const MAIN_CHANNELS: Record<keyof MuswagMainIpc, true> = {
  "app:connect": true,
  "appUpdate:check": true,
  "appUpdate:install": true,
  "app:command": true,
  "player:command": true,
  "player:locate": true,
};

const RENDERER_CHANNELS: Record<keyof MuswagRendererEvents, true> = { "app:state": true, "library:changed": true };

export const INVOKE_CHANNELS: ReadonlyArray<string> = Object.keys(MAIN_CHANNELS);

export const EVENT_CHANNELS: ReadonlyArray<string> = Object.keys(RENDERER_CHANNELS);

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * `window.electron`, as the preload exposes it and as `renderer/data/dev-bridge.ts` stands in for it
 * in a browser. It has the shape `@electron-toolkit/typed-ipc` expects.
 */
export interface ElectronBridge {
  readonly ipcRenderer: {
    readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
    /** Listens to what main sends on a channel. Returns the function that stops listening. */
    readonly on: (channel: string, listener: Listener) => () => void;
  };
}
