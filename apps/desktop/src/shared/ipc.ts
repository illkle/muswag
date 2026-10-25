/**
 * The channel a renderer asks main for anything on: it runs a command from `commands/app.ts` and
 * replies with an `AppCommandReply`.
 */
export const APP_COMMAND_CHANNEL = "app:command";

/**
 * The channel a renderer connects on, once and before anything else: main starts sending it the events
 * of `EVENT_CHANNELS`, and replies with its state as of then, an `AppStateSnapshot` (`state/app-state.ts`).
 */
export const APP_CONNECT_CHANNEL = "app:connect";

/** What main sends a connected renderer, by channel. */
export type MuswagRendererEvents = {
  /** A value of main's state changed: an `AppStateUpdate`. */
  "app:state": unknown;
  /** Writes changed rows of the library: a `LibraryChangedEvent`. */
  "library:changed": unknown;
};

const RENDERER_CHANNELS: Record<keyof MuswagRendererEvents, true> = { "app:state": true, "library:changed": true };

/** Every channel the renderer uses, which is all the preload lets through. */
export const INVOKE_CHANNELS: ReadonlyArray<string> = [APP_COMMAND_CHANNEL, APP_CONNECT_CHANNEL];

export const EVENT_CHANNELS: ReadonlyArray<string> = Object.keys(RENDERER_CHANNELS);

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * `window.electron`, as the preload exposes it and as `renderer/data/dev-bridge.ts` stands in for it
 * in a browser.
 */
export interface ElectronBridge {
  readonly ipcRenderer: {
    readonly invoke: (channel: string, ...args: Array<unknown>) => Promise<unknown>;
    /** Listens to what main sends on a channel. Returns the function that stops listening. */
    readonly on: (channel: string, listener: Listener) => () => void;
  };
}
