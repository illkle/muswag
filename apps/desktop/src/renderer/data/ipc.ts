import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/renderer";

import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";

export const mainIpc = new IpcEmitter<MuswagMainIpc>();
export const rendererIpc = new IpcListener<MuswagRendererIpc>();
