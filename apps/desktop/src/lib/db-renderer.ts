import { createElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence";
import { createMuswagDb } from "@muswag/shared/db";

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) => window.electron.ipcRenderer.invoke(channel, request),
});

export const db = createMuswagDb(persistence);
