import { createElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence";
import { createMuswagDb } from "@muswag/shared/db";
import { queryOnce } from "@tanstack/react-db";
import { PlayerIPC } from "#/lib/ipc";
import { CreateFuse } from "@muswag/shared";

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) => window.electron.ipcRenderer.invoke(channel, request),
});

export const db = createMuswagDb(persistence);

const queryAndSetCredentials = () => {
  queryOnce((v) => v.from({ user: db.userCredentials }).findOne()).then((v) => {
    void PlayerIPC.setCredentials(v ?? null);
  });
};

db.userCredentials.subscribeChanges(queryAndSetCredentials, { includeInitialState: true });

export const FuzeSearch = CreateFuse(db);
