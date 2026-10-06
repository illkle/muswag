import type { ElectronAPI } from "@electron-toolkit/preload";

type Listener = (event: unknown, ...args: Array<unknown>) => void;
type InvokeReply = { readonly ok: true; readonly result?: unknown } | { readonly ok: false; readonly error: string };

/**
 * Development only: true when the renderer runs in a plain browser, where no preload has set
 * `window.electron`. This module then stands in for it, carrying IPC over HTTP to main's dev bridge
 * (`main/dev-bridge.ts`).
 */
export const viaDevBridge = import.meta.env.MODE === "development" && !("electron" in window);

if (viaDevBridge) {
  const client = crypto.randomUUID();
  const listeners = new Map<string, Set<Listener>>();

  const events = new EventSource(`/__bridge/events?client=${client}`);
  const opened = new Promise<void>((resolve) => events.addEventListener("open", () => resolve(), { once: true }));
  events.addEventListener("message", ({ data }) => {
    const { channel, args } = JSON.parse(data as string) as { channel: string; args: Array<unknown> };
    for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
  });
  // Main is down or restarting, and what it knew of this tab went with it: start over once it is back.
  events.addEventListener("error", () => {
    events.close();
    setInterval(() => {
      void fetch("/__bridge/ping").then(
        (response) => response.ok && window.location.reload(),
        () => {},
      );
    }, 1000);
  });

  const ipcRenderer = {
    invoke: async (channel: string, ...args: Array<unknown>) => {
      // Main only answers a tab whose event stream it has.
      await opened;
      const response = await fetch("/__bridge/invoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client, channel, args }) });
      const reply = (await response.json()) as InvokeReply;
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    },
    on: (channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      listeners.set(channel, channelListeners.add(listener));
      return () => channelListeners.delete(listener);
    },
  };

  window.electron = { ipcRenderer } as unknown as ElectronAPI;
}
