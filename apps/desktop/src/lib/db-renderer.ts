import {
  createElectronSQLitePersistence,
  ElectronCollectionCoordinator,
} from '@tanstack/electron-db-sqlite-persistence';
import { createMuswagDb } from '@muswag/shared/db';

const DB_NAME = 'muswag';

const coordinator = new ElectronCollectionCoordinator({ dbName: DB_NAME });

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) =>
    window.electron.ipcRenderer.invoke(channel, request),
  coordinator,
});

export const db = createMuswagDb(persistence);

export const dbReady = Promise.all([
  db.albums.preload(),
  db.songs.preload(),
  db.userCredentials.preload(),
  db.syncs.preload(),
]).then(() => undefined);
