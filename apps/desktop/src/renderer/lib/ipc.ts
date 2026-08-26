import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { AppUpdateState, MpvInstallOutput, MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import type { ApplyMpvQueueInput, MpvInstallMethod, PlayerEvent, PlayerRuntimeState } from "#shared/player";
import type { SessionCredentials } from "@muswag/shared";

const mainIpc = new IpcEmitter<MuswagMainIpc>();
const rendererIpc = new IpcListener<MuswagRendererIpc>();

const subscribePlayer = (listener: (event: PlayerEvent) => void) => rendererIpc.on("player:event", (_event, payload) => listener(payload));

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
  applyQueue: (input: ApplyMpvQueueInput) => mainIpc.invoke("player:applyQueue", input),
  getState: () => mainIpc.invoke("player:getState"),
  getRuntimeState: async () => (await mainIpc.invoke("player:getState")).runtime,
  pause: () => mainIpc.invoke("player:pause"),
  play: () => mainIpc.invoke("player:play"),
  restartCurrent: () => mainIpc.invoke("player:restartCurrent"),
  seek: (positionSeconds: number) => mainIpc.invoke("player:seek", positionSeconds),
  setCredentials: (credentials: SessionCredentials | null) => mainIpc.invoke("player:setCredentials", credentials),
  setMuted: (muted: boolean) => mainIpc.invoke("player:setMuted", muted),
  setVolume: (volumePercent: number) => mainIpc.invoke("player:setVolume", volumePercent),
  subscribe: subscribePlayer,
  subscribeRuntime: (listener: (state: PlayerRuntimeState) => void) => subscribePlayer((event) => event.type === "runtime" && listener(event.state)),
  stop: () => mainIpc.invoke("player:stop"),
  toggle: () => mainIpc.invoke("player:toggle"),
};

export const FilesystemIpc = {
  writeFile: (path: string, data: Uint8Array) => mainIpc.invoke("fs:write", path, data),
  remove: (path: string) => mainIpc.invoke("fs:delete", path),
};
