import { createElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence";
import { createMuswagDb } from "@muswag/shared/db";
import { queryOnce } from "@tanstack/react-db";
import { PlayerIPC } from "#/lib/ipc";

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) => window.electron.ipcRenderer.invoke(channel, request),
});

export const db = createMuswagDb(persistence);

const queryAndSetCredentials = () => {
  queryOnce((v) => v.from({ user: db.userCredentials }).findOne()).then((v) => {
    if (v) {
      PlayerIPC.setCredentials(v);
    }
  });
};

db.userCredentials.subscribeChanges(queryAndSetCredentials, { includeInitialState: true });
