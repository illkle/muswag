import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";

import type { IpcMain } from "electron";
import { afterEach, describe, expect, it } from "vitest";

import { guardIpc } from "./app-page";
import { startDevBridge } from "./dev-bridge";

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** The status the bridge answers a ping with when the request names `host`. */
const ping = (port: number, host: string) =>
  new Promise<number>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/__bridge/ping", headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe("startDevBridge", () => {
  it("answers only requests that name it as the host", async () => {
    const port = await freePort();
    const ipcMain = { handle: () => {}, removeHandler: () => {} } as unknown as IpcMain;
    stop = startDevBridge({ ipcMain, port, serveCover: async () => new Response(null, { status: 404 }) });

    expect(await ping(port, `127.0.0.1:${port}`)).toBe(204);
    // A page that had its own name resolve to this machine.
    expect(await ping(port, `rebound.example:${port}`)).toBe(403);
    expect(await ping(port, "127.0.0.1")).toBe(403);
  });

  it("answers through the handlers as registered, before the guard that turns down pages other than the app's", async () => {
    const port = await freePort();
    const electronHandlers = new Map<string, (event: unknown, ...args: Array<unknown>) => unknown>();
    const ipcMain = { handle: (channel: string, listener: never) => void electronHandlers.set(channel, listener), removeHandler: () => {} } as unknown as IpcMain;
    const guarded = guardIpc(ipcMain, "http://127.0.0.1:5173/");
    stop = startDevBridge({ ipcMain: guarded, port, serveCover: async () => new Response(null, { status: 404 }) });
    guarded.handle("app:command", (_event, name) => `ran ${String(name)}`);

    const base = `http://127.0.0.1:${port}/__bridge`;
    const events = new AbortController();
    const stream = await fetch(`${base}/events?client=tab`, { signal: events.signal });
    try {
      const response = await fetch(`${base}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: "tab", channel: "app:command", args: ["queue:next", []] }),
      });
      expect(await response.json()).toEqual({ ok: true, result: "ran queue:next" });
    } finally {
      events.abort();
      await stream.body?.cancel().catch(() => {});
    }
    // Electron itself gets the guarded handler, which a message without the app's frame does not get through.
    expect(() => electronHandlers.get("app:command")!({ senderFrame: null }, "queue:next", [])).toThrow("only answered for the app's own page");
  });
});
