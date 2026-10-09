import { IpcEmitter } from "@electron-toolkit/typed-ipc/renderer";

import type { MuswagMainIpc } from "#shared/ipc";

export const mainIpc = new IpcEmitter<MuswagMainIpc>();
