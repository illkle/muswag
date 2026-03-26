import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { MuswagMainIpc, MuswagRendererIpc } from "../shared/ipc";
import type { PlayQueueInput, PlayerEvent } from "../shared/player";

const mainIpc = new IpcEmitter<MuswagMainIpc>();
const rendererIpc = new IpcListener<MuswagRendererIpc>();

export const PlayerIPC = {
  getState: () => mainIpc.invoke("player:getState"),
  next: () => mainIpc.invoke("player:next"),
  pause: () => mainIpc.invoke("player:pause"),
  play: () => mainIpc.invoke("player:play"),
  playQueue: (input: PlayQueueInput) => mainIpc.invoke("player:playQueue", input),
  previous: () => mainIpc.invoke("player:previous"),
  seek: (positionSeconds: number) => mainIpc.invoke("player:seek", positionSeconds),
  subscribe: (listener: (event: PlayerEvent) => void) =>
    rendererIpc.on("player:event", (_event, payload) => {
      listener(payload);
    }),
  toggle: () => mainIpc.invoke("player:toggle"),
};
