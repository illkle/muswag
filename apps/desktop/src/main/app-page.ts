import type { IpcMain, IpcMainInvokeEvent } from "electron";

/** What main's handlers are registered with: `ipcMain`, or `guardIpc`'s stand-in for it. */
export type AppIpc = Pick<IpcMain, "handle" | "removeHandler">;

/**
 * Whether `url` is the app's own page, the one the window loads from `pageUrl`. In development that
 * is any page of the dev server; otherwise it is the renderer's `index.html`, whatever route its hash
 * names. A file dropped on the window is a `file:` page too, but not this one.
 */
export function isAppPage(pageUrl: string, url: string): boolean {
  const page = new URL(pageUrl);
  const target = URL.parse(url);
  if (!target) return false;
  if (page.protocol === "file:") return target.protocol === "file:" && target.host === page.host && target.pathname === page.pathname;
  return target.origin === page.origin;
}

/** Whether an IPC message comes from the app's page itself, not from a frame inside it. */
const fromAppPage = (event: IpcMainInvokeEvent, pageUrl: string): boolean => {
  const frame = event.senderFrame;
  return frame !== null && frame.parent === null && isAppPage(pageUrl, frame.url);
};

/**
 * `ipcMain` with every handler answering only the app's own page. The preload exposes the app's
 * channels to whatever page the window shows, so a page that got there by any other way must not be
 * able to run the app's commands.
 */
export function guardIpc(ipcMain: AppIpc, pageUrl: string): AppIpc {
  return {
    handle: (channel, listener) =>
      ipcMain.handle(channel, (event, ...args) => {
        if (!fromAppPage(event, pageUrl)) throw new Error(`'${channel}' is only answered for the app's own page`);
        return listener(event, ...args);
      }),
    removeHandler: (channel) => ipcMain.removeHandler(channel),
  };
}
