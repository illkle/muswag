import { DEFAULT_MIRROR_CHANNEL } from "@muswag/tanstack-db-mirror/electron/renderer";

/**
 * The channel a renderer asks main for anything on: it runs a command from `commands/app.ts` and
 * replies with an `AppCommandReply`. Everything else a renderer reads from the mirrors.
 */
export const APP_COMMAND_CHANNEL = "app:command";

/** The channel of the mirror of main's in-memory state (`state/mirror.ts`); the library's mirror has the default one. */
export const STATE_MIRROR_CHANNEL = "muswag-state";

const MIRROR_CHANNELS = [DEFAULT_MIRROR_CHANNEL, STATE_MIRROR_CHANNEL];

/**
 * Every channel the renderer uses, which is all the preload lets through: the command channel and,
 * for each mirror, the requests it makes and the changes main sends it.
 */
export const INVOKE_CHANNELS: ReadonlyArray<string> = [APP_COMMAND_CHANNEL, ...MIRROR_CHANNELS.map((channel) => `${channel}:request`)];

export const EVENT_CHANNELS: ReadonlyArray<string> = MIRROR_CHANNELS.map((channel) => `${channel}:changes`);

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * `window.electron`, as the preload exposes it and as `renderer/data/dev-bridge.ts` stands in for it
 * in a browser. It has the shape the mirror transport expects.
 */
export interface ElectronBridge {
  readonly ipcRenderer: {
    readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
    /** Listens to what main sends on a channel. Returns the function that stops listening. */
    readonly on: (channel: string, listener: Listener) => () => void;
  };
}
