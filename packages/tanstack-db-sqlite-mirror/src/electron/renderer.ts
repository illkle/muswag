import type { MirrorChangeBatch, MirrorClientTransport, MirrorResponse } from "../protocol.js";
import { DEFAULT_MIRROR_CHANNEL, mirrorChannels } from "./channels.js";

export { DEFAULT_MIRROR_CHANNEL };

type Listener = (event: unknown, ...args: Array<unknown>) => void;

/**
 * The subset of Electron's `ipcRenderer` the transport uses. Matches both the raw `ipcRenderer`
 * (where `on` returns the emitter) and `@electron-toolkit/preload` (where `on` returns an unsubscribe function).
 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: Array<unknown>): Promise<unknown>;
  on(channel: string, listener: Listener): unknown;
  removeListener?(channel: string, listener: Listener): unknown;
}

export interface ElectronRendererTransportOptions {
  readonly ipcRenderer: IpcRendererLike;
  readonly channel?: string | undefined;
}

export function createElectronRendererTransport(options: ElectronRendererTransportOptions): MirrorClientTransport {
  const { ipcRenderer } = options;
  const channels = mirrorChannels(options.channel ?? DEFAULT_MIRROR_CHANNEL);

  return {
    request: (request) => ipcRenderer.invoke(channels.request, request) as Promise<MirrorResponse<typeof request.type>>,
    subscribe: (listener) => {
      const onChanges: Listener = (_event, batch) => listener(batch as MirrorChangeBatch);
      const unsubscribe = ipcRenderer.on(channels.changes, onChanges);
      return () => {
        if (typeof unsubscribe === "function") unsubscribe();
        else ipcRenderer.removeListener?.(channels.changes, onChanges);
      };
    },
  };
}
