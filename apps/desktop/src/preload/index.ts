import { contextBridge, ipcRenderer } from "electron";

import { EVENT_CHANNELS, INVOKE_CHANNELS, type ElectronBridge } from "#shared/ipc";

const refuse = (channel: string): never => {
  throw new Error(`The channel '${channel}' is not one of the app's`);
};

/**
 * All the page gets of Electron: the app's own channels. The window is sandboxed, so this file may
 * `require` nothing but `electron`; what it imports is bundled into it.
 */
const bridge: ElectronBridge = {
  ipcRenderer: {
    invoke: (channel, ...args) => (INVOKE_CHANNELS.includes(channel) ? ipcRenderer.invoke(channel, ...args) : refuse(channel)),
    on: (channel, listener) => {
      if (!EVENT_CHANNELS.includes(channel)) refuse(channel);
      // The event is kept from the page: it carries the whole `ipcRenderer` as its sender.
      const forward = (_event: unknown, ...args: Array<unknown>) => listener(null, ...args);
      ipcRenderer.on(channel, forward);
      return () => void ipcRenderer.removeListener(channel, forward);
    },
  },
};

contextBridge.exposeInMainWorld("electron", bridge);
