import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

import type { MuswagDesktopApi, SqliteQueryRequest, SqliteQueryResponse } from "../shared/sqlite";

const api: MuswagDesktopApi = {
  querySqlite: (request: SqliteQueryRequest): Promise<SqliteQueryResponse> =>
    ipcRenderer.invoke("sqlite:query", request),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("electron", electronAPI);
  contextBridge.exposeInMainWorld("api", api);
}
