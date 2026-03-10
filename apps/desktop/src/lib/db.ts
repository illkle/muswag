import type { GetSongsInput, SyncCredentials, SyncManagerEvent } from "@muswag/db";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { MuswagMainIpc, MuswagRendererIpc } from "../shared/ipc";
import type { PlayQueueInput, PlayerEvent } from "../shared/player";

const mainIpc = new IpcEmitter<MuswagMainIpc>();
const rendererIpc = new IpcListener<MuswagRendererIpc>();

export const dbHooks = {
  getAlbumDetail: (albumId: string) => mainIpc.invoke("db:getAlbumDetail", albumId),
  getAlbums: () => mainIpc.invoke("db:getAlbums"),
  getSongs: (input?: GetSongsInput) => mainIpc.invoke("db:getSongs", input),
};

export const Player = {
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

export const SM = {
  getUserState: () => mainIpc.invoke("sync:getUserState"),
  login: (credentials: SyncCredentials) => mainIpc.invoke("sync:login", credentials),
  logout: () => mainIpc.invoke("sync:logout"),
  subscribe: (listener: (event: SyncManagerEvent) => void) =>
    rendererIpc.on("sync:event", (_event, payload) => {
      listener(payload);
    }),
  sync: () => mainIpc.invoke("sync:run"),
};
