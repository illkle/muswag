import { ipcRenderer } from 'electron';
import { createElectronSQLitePersistence } from '@tanstack/electron-db-sqlite-persistence';
import { createMuswagDb } from '@muswag/shared';

const persistence = createElectronSQLitePersistence({
  ipcRenderer,
});

export const db = createMuswagDb(persistence);
