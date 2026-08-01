import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { AppUpdateState, MpvInstallOutput, MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import type { MpvInstallMethod, PlayQueueInput, PlayerEvent } from "#shared/player";
import type { UserCredentialsToLogin } from "@muswag/shared";

const mainIpc = new IpcEmitter<MuswagMainIpc>();
const rendererIpc = new IpcListener<MuswagRendererIpc>();

export const AppUpdateIPC = {
  check: () => mainIpc.invoke("appUpdate:check"),
  getState: () => mainIpc.invoke("appUpdate:getState"),
  install: () => mainIpc.invoke("appUpdate:install"),
  subscribe: (listener: (state: AppUpdateState) => void) =>
    rendererIpc.on("appUpdate:state", (_event, state) => {
      listener(state);
    }),
};

export const MpvIPC = {
  cancelInstall: () => mainIpc.invoke("mpv:cancelInstall"),
  clearManualPath: () => mainIpc.invoke("mpv:clearManualPath"),
  install: (method: MpvInstallMethod) => mainIpc.invoke("mpv:install", method),
  locate: () => mainIpc.invoke("mpv:locate"),
  recheck: () => mainIpc.invoke("mpv:recheck"),
  subscribeInstallOutput: (listener: (output: MpvInstallOutput) => void) =>
    rendererIpc.on("mpv:installOutput", (_event, output) => {
      listener(output);
    }),
};

export const PlayerIPC = {
  getState: () => mainIpc.invoke("player:getState"),
  next: () => mainIpc.invoke("player:next"),
  pause: () => mainIpc.invoke("player:pause"),
  play: () => mainIpc.invoke("player:play"),
  playQueue: (input: PlayQueueInput) => mainIpc.invoke("player:playQueue", input),
  previous: () => mainIpc.invoke("player:previous"),
  seek: (positionSeconds: number) => mainIpc.invoke("player:seek", positionSeconds),
  setCredentials: (credentials: UserCredentialsToLogin | null) => mainIpc.invoke("player:setCredentials", credentials),
  setMuted: (muted: boolean) => mainIpc.invoke("player:setMuted", muted),
  setVolume: (volumePercent: number) => mainIpc.invoke("player:setVolume", volumePercent),
  subscribe: (listener: (event: PlayerEvent) => void) =>
    rendererIpc.on("player:event", (_event, payload) => {
      listener(payload);
    }),
  toggle: () => mainIpc.invoke("player:toggle"),
};

export const CoverArtIPC = {
  listFiles: () => mainIpc.invoke("coverArt:listFiles"),
  removeFile: (path: string) => mainIpc.invoke("coverArt:removeFile", path),
  removeFiles: (key: string) => mainIpc.invoke("coverArt:removeFiles", key),
  writeFile: (key: string, extension: string, bytes: Uint8Array) => mainIpc.invoke("coverArt:writeFile", key, extension, bytes),
};
