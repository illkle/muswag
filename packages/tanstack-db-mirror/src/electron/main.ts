import type { MirrorChangeBatch, MirrorResponse, MirrorServerTransport } from "../protocol.js";
import { DEFAULT_MIRROR_CHANNEL, mirrorChannels } from "./channels.js";

export { DEFAULT_MIRROR_CHANNEL };

/** The subset of Electron's `WebContents` the transport uses. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: Array<unknown>): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

/** The subset of Electron's `ipcMain` the transport uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: { readonly sender: WebContentsLike }, request: unknown) => Promise<MirrorResponse>): void;
  removeHandler(channel: string): void;
}

export interface ElectronMainTransportOptions {
  readonly ipcMain: IpcMainLike;
  readonly channel?: string | undefined;
}

// Renderers stay registered across transports on the same ipcMain and channel, so a server
// restarted in the same main process keeps pushing to renderers that connected to the old one.
const registries = new WeakMap<IpcMainLike, Map<string, Map<number, WebContentsLike>>>();

const clientsFor = (ipcMain: IpcMainLike, channel: string) => {
  let byChannel = registries.get(ipcMain);
  if (!byChannel) registries.set(ipcMain, (byChannel = new Map()));
  let clients = byChannel.get(channel);
  if (!clients) byChannel.set(channel, (clients = new Map()));
  return clients;
};

/**
 * Serves mirror requests over `ipcMain.handle` and pushes change batches with `webContents.send`.
 * Batches go to every renderer that has made a request and is still alive.
 */
export function createElectronMainTransport(options: ElectronMainTransportOptions): MirrorServerTransport {
  const channels = mirrorChannels(options.channel ?? DEFAULT_MIRROR_CHANNEL);
  const clients = clientsFor(options.ipcMain, channels.request);

  const track = (sender: WebContentsLike) => {
    if (clients.has(sender.id) || sender.isDestroyed()) return;
    clients.set(sender.id, sender);
    sender.once("destroyed", () => {
      if (clients.get(sender.id) === sender) clients.delete(sender.id);
    });
  };

  return {
    listen: (handler) => {
      options.ipcMain.handle(channels.request, (event, request) => {
        // Registered before the request runs, so every batch broadcast after the handler reads
        // the stream position reaches this renderer.
        track(event.sender);
        return handler(request);
      });
      return () => options.ipcMain.removeHandler(channels.request);
    },
    broadcast: (batch: MirrorChangeBatch) => {
      for (const [id, contents] of clients) {
        if (contents.isDestroyed()) {
          clients.delete(id);
          continue;
        }
        try {
          contents.send(channels.changes, batch);
        } catch (cause) {
          // The renderer misses this batch and recovers through its gap check.
          console.error("[tanstack-db-mirror] failed to send changes to a renderer", cause);
        }
      }
    },
  };
}
