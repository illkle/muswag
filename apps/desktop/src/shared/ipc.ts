import { DEFAULT_MIRROR_CHANNEL } from "@muswag/tanstack-db-mirror/electron/renderer";

/** What a renderer can ask of main, by channel. Everything else it reads from the mirrors. */
export type MuswagMainIpc = {
  /** Checks for an update now. The outcome arrives in the update state (`state/app-update.ts`). */
  "appUpdate:check": () => void;
  /** Quits and installs a downloaded update. Does nothing until the status is `ready`. */
  "appUpdate:install": () => void;

  /** Runs a command from `commands/app.ts`; replies with an `AppCommandReply`. */
  "app:command": (name: string, args: readonly unknown[]) => unknown;

  // Player payloads are `unknown` on both sides: main decodes a renderer's commands and the renderer
  // decodes results against the schemas in commands/player.ts. The player's state reaches renderers
  // through the state mirror (state/player.ts).
  "player:command": (command: unknown) => unknown;
  "player:locate": () => unknown;
};

/** The channel of the mirror of main's in-memory state (`state/mirror.ts`); the library's mirror has the default one. */
export const STATE_MIRROR_CHANNEL = "muswag-state";

const MIRROR_CHANNELS = [DEFAULT_MIRROR_CHANNEL, STATE_MIRROR_CHANNEL];

/**
 * Every channel the renderer uses, which is all the preload lets through: the ones above and, for
 * each mirror, the requests it makes and the changes main sends it.
 */
const MAIN_CHANNELS: Record<keyof MuswagMainIpc, true> = {
  "appUpdate:check": true,
  "appUpdate:install": true,
  "app:command": true,
  "player:command": true,
  "player:locate": true,
};

export const INVOKE_CHANNELS: ReadonlyArray<string> = [...Object.keys(MAIN_CHANNELS), ...MIRROR_CHANNELS.map((channel) => `${channel}:request`)];

export const EVENT_CHANNELS: ReadonlyArray<string> = MIRROR_CHANNELS.map((channel) => `${channel}:changes`);

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * `window.electron`, as the preload exposes it and as `renderer/data/dev-bridge.ts` stands in for it
 * in a browser. It has the shape the mirror transport and `@electron-toolkit/typed-ipc` expect.
 */
export interface ElectronBridge {
  readonly ipcRenderer: {
    readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
    /** Listens to what main sends on a channel. Returns the function that stops listening. */
    readonly on: (channel: string, listener: Listener) => () => void;
  };
}
