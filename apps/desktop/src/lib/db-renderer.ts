import {
  createElectronSQLitePersistence,
  ElectronCollectionCoordinator,
} from '@tanstack/electron-db-sqlite-persistence';
import { createMuswagDb } from '@muswag/shared/db';

const DB_NAME = 'muswag';
const COLLECTION_IDS = ['albums', 'songs', 'userCredentials', 'syncs'] as const;

const coordinator = new ElectronCollectionCoordinator({ dbName: DB_NAME });

const persistence = createElectronSQLitePersistence({
  invoke: (channel, request) =>
    window.electron.ipcRenderer.invoke(channel, request),
  coordinator,
});

export const db = createMuswagDb(persistence);

export function reloadAllDbCollections(): void {
  const senderId = `main:${crypto.randomUUID()}`;
  const resetEpoch = Date.now();
  const channel = new BroadcastChannel(`tsdb:coord:${DB_NAME}`);

  for (const collectionId of COLLECTION_IDS) {
    channel.postMessage({
      v: 1,
      dbName: DB_NAME,
      collectionId,
      senderId,
      ts: Date.now(),
      payload: {
        type: 'collection:reset',
        schemaVersion: 1,
        resetEpoch,
      },
    });
  }

  setTimeout(() => {
    channel.close();
  }, 0);
}
