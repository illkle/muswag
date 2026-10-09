import { request } from "node:http";
import { createServer, type AddressInfo } from "node:net";

import type { IpcMain } from "electron";
import { afterEach, describe, expect, it } from "vitest";

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
});
