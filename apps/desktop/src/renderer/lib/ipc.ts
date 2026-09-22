import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { AppUpdateState, MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";

export const mainIpc = new IpcEmitter<MuswagMainIpc>();
export const rendererIpc = new IpcListener<MuswagRendererIpc>();

export const AppUpdateIPC = {
  check: () => mainIpc.invoke("appUpdate:check"),
  getState: () => mainIpc.invoke("appUpdate:getState"),
  install: () => mainIpc.invoke("appUpdate:install"),
  subscribe: (listener: (state: AppUpdateState) => void) =>
    rendererIpc.on("appUpdate:state", (_event, state) => {
      listener(state);
    }),
};

export const FilesystemIpc = {
  writeFile: (path: string, data: Uint8Array) => mainIpc.invoke("fs:write", path, data),
  remove: (path: string) => mainIpc.invoke("fs:delete", path),
};
