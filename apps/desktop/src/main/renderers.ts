import type { LibraryChange } from "@muswag/backend";

import { APP_CONNECT_CHANNEL, type MuswagRendererEvents } from "#shared/ipc";
import type { AppStateHub } from "./app-state";
import type { LibraryChangedEvent } from "#shared/state/app-state";

/** The part of Electron's `WebContents` main sends events with. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: Array<unknown>): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/** The part of Electron's `ipcMain` that renderers connect through. */
export interface ConnectIpc {
  handle(channel: string, listener: (event: { readonly sender: WebContentsLike }) => unknown): void;
  removeHandler(channel: string): void;
}

/** Past this many rows of a table in one write, renderers hear only that the table changed. */
const LISTED_KEYS = 1_000;

/** `changes` as renderers hear of them: by table, with the keys where there are few enough. */
export function libraryChangedEvent(changes: ReadonlyArray<LibraryChange>): LibraryChangedEvent {
  const tables: Record<string, Array<string | number> | null> = {};
  for (const { table, key } of changes) {
    const keys = table in tables ? tables[table]! : (tables[table] = []);
    if (keys === null) continue;
    if (keys.length < LISTED_KEYS) keys.push(key);
    else tables[table] = null;
  }
  return { tables };
}

/**
 * The renderers that have connected, which main sends its events to: every change of `state`, and
 * whatever else is sent through `send`. A renderer connects with `app:connect`, which replies with the
 * state as of then. Events go to every renderer still alive, in the order they are sent.
 */
export function serveRenderers(ipcMain: ConnectIpc, state: AppStateHub) {
  const renderers = new Map<number, WebContentsLike>();

  const send = <K extends keyof MuswagRendererEvents>(channel: K, payload: MuswagRendererEvents[K]) => {
    for (const [id, contents] of renderers) {
      if (contents.isDestroyed()) {
        renderers.delete(id);
        continue;
      }
      try {
        contents.send(channel, payload);
      } catch (cause) {
        console.error(`[renderers] failed to send ${channel}`, cause);
      }
    }
  };

  ipcMain.handle(APP_CONNECT_CHANNEL, ({ sender }) => {
    // Before the snapshot is taken, so the renderer hears of every change after it.
    if (!renderers.has(sender.id) && !sender.isDestroyed()) {
      renderers.set(sender.id, sender);
      sender.once("destroyed", () => {
        if (renderers.get(sender.id) === sender) renderers.delete(sender.id);
      });
    }
    return state.snapshot();
  });
  const unsubscribe = state.subscribe((update) => send("app:state", update));

  return {
    send,
    dispose: () => {
      unsubscribe();
      ipcMain.removeHandler(APP_CONNECT_CHANNEL);
      renderers.clear();
    },
  };
}

export type Renderers = ReturnType<typeof serveRenderers>;
