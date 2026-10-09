import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";

import type { WebContentsLike } from "@muswag/tanstack-db-mirror/electron/main";
import type { IpcMain } from "electron";

import type { ServeCover } from "./cover-protocol";

type Handler = (event: { readonly sender: WebContentsLike }, ...args: Array<unknown>) => unknown;

export interface DevBridgeOptions {
  readonly ipcMain: IpcMain;
  readonly port: number;
  readonly serveCover: ServeCover;
}

/**
 * Development only: serves this app's IPC over HTTP, so that a browser can run the renderer.
 * `renderer/data/dev-bridge.ts` is the other end. To the handlers, every browser tab is a renderer of its own.
 *
 * Whatever reaches the port can run every command, so it listens on loopback only; the Vite dev server
 * proxies `/__bridge` to it, naming the bridge as the host. A request that names another host is a page
 * that had a name of its own resolve to this machine, and is refused.
 * Requests are separate HTTP calls, so unlike IPC they may arrive out of order.
 * Returns the function that stops it.
 */
export function startDevBridge({ ipcMain, port, serveCover }: DevBridgeOptions): () => void {
  // `ipcMain` does not give its handlers back, so the bridge keeps the ones registered from here on.
  const handlers = new Map<string, Handler>();
  const handle = ipcMain.handle.bind(ipcMain);
  const removeHandler = ipcMain.removeHandler.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    handle(channel, listener);
    handlers.set(channel, listener as Handler);
  };
  ipcMain.removeHandler = (channel) => {
    removeHandler(channel);
    handlers.delete(channel);
  };

  const clients = new Map<string, WebContentsLike>();
  // Real `webContents` count up from 1.
  let nextId = -1;

  /** The stream main's messages reach a tab on; the tab is gone when it closes. */
  const openEvents = (client: string, response: ServerResponse) => {
    const destroyed: Array<() => void> = [];
    let open = true;
    clients.set(client, {
      id: nextId--,
      send: (channel, ...args) => void response.write(`data: ${JSON.stringify({ channel, args })}\n\n`),
      isDestroyed: () => !open,
      once: (_event, listener) => destroyed.push(listener),
    });
    response.on("close", () => {
      open = false;
      clients.delete(client);
      for (const listener of destroyed) listener();
    });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(": open\n\n");
  };

  const invoke = async (request: IncomingMessage): Promise<unknown> => {
    const { client, channel, args } = (await json(request)) as { client: string; channel: string; args: Array<unknown> };
    const sender = clients.get(client);
    if (!sender) throw new Error(`No event stream is open for client '${client}'`);
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for '${channel}'`);
    return handler({ sender }, ...args);
  };

  const host = `127.0.0.1:${port}`;

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.headers.host !== host) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const sendJson = (body: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

    const cover = request.method === "GET" && /^\/__bridge\/cover\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (cover) {
      const served = await serveCover({ type: cover[1]!, id: decodeURIComponent(cover[2]!), thumbnail: url.searchParams.has("thumbnail") });
      const contentType = served.headers.get("content-type");
      response.writeHead(served.status, contentType ? { "content-type": contentType } : {}).end(Buffer.from(await served.arrayBuffer()));
      return;
    }

    switch (`${request.method} ${url.pathname}`) {
      case "GET /__bridge/ping":
        // No content: the dev server answers this path with its page when the bridge is not behind it.
        response.writeHead(204).end();
        return;
      case "GET /__bridge/events":
        openEvents(url.searchParams.get("client") ?? "", response);
        return;
      case "POST /__bridge/invoke":
        // A page of another origin cannot send JSON without a preflight, which is not answered.
        if (request.headers["content-type"] !== "application/json") break;
        sendJson(
          await invoke(request).then(
            (result) => ({ ok: true, result }),
            (cause: unknown) => ({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }),
          ),
        );
        return;
    }
    response.writeHead(404).end();
  };

  const server = createServer((request, response) => {
    route(request, response).catch((cause: unknown) => {
      console.error("[dev-bridge] request failed", request.url, cause);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  })
    .on("error", (cause) => console.error("[dev-bridge] server failed", cause))
    .listen(port, "127.0.0.1", () => console.log(`[dev-bridge] listening on 127.0.0.1:${port}`));
  return () => void server.close();
}
