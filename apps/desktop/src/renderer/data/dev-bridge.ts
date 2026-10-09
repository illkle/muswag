import type { ElectronBridge } from "#shared/ipc";

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
  // Main is down, restarting, or runs without the bridge, and what it knew of this tab went with it:
  // say so, and start over once the bridge answers. Without it the dev server answers the ping with
  // its page, so only the bridge's own empty answer counts.
  events.addEventListener("error", () => {
    events.close();
    const notice = document.createElement("p");
    notice.className = "fixed inset-x-0 bottom-0 z-50 border-t border-border bg-muted px-4 py-2 text-sm text-muted-foreground";
    notice.textContent = "Waiting for the muswag dev app. It has to run with MUSWAG_DEV_BRIDGE_PORT set.";
    document.body.append(notice);
    setInterval(() => {
      void fetch("/__bridge/ping").then(
        (response) => response.status === 204 && window.location.reload(),
        () => {},
      );
    }, 1000);
  });

  const ipcRenderer: ElectronBridge["ipcRenderer"] = {
    invoke: async (channel, ...args) => {
      // Main only answers a tab whose event stream it has.
      await opened;
      const response = await fetch("/__bridge/invoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client, channel, args }) });
      const reply = (await response.json()) as InvokeReply;
      if (!reply.ok) throw new Error(reply.error);
      return reply.result;
    },
    on: (channel, listener) => {
      const channelListeners = listeners.get(channel) ?? new Set();
      listeners.set(channel, channelListeners.add(listener));
      return () => channelListeners.delete(listener);
    },
  };

  window.electron = { ipcRenderer };
}
