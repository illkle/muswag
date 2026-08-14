import { createElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence";
import { createMuswagDb } from "#core/db";
import { queryOnce } from "@tanstack/react-db";
import { PlayerIPC } from "#/lib/ipc";
import { CreateFuse } from "#core";

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) => window.electron.ipcRenderer.invoke(channel, request),
});

export const db = createMuswagDb(persistence);

const queryAndSetCredentials = async () => {
  const credentials = await queryOnce((v) => v.from({ user: db.userCredentials }).findOne());
  await PlayerIPC.setCredentials(credentials ?? null);
};

/** Resolves after the initial persisted credentials have reached the main player. */
export const dbPlayerReady = queryAndSetCredentials();
db.userCredentials.subscribeChanges(queryAndSetCredentials);

export const FuzeSearch = CreateFuse(db);
