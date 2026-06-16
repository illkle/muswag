import { exposeElectronSQLitePersistence } from '@tanstack/electron-db-sqlite-persistence/main';
import { createNodeSQLitePersistence } from '@tanstack/node-db-sqlite-persistence';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { ipcMain } from 'electron';
import { createMuswagDb } from '@muswag/shared/db';

const dbP = join(app.getPath('userData'), 'muswag.db');

const database = new Database(dbP);

const persistence = createNodeSQLitePersistence({
  database,
});

export const db = createMuswagDb(persistence);

export const dbReady = Promise.all([
  db.albums.preload(),
  db.songs.preload(),
  db.userCredentials.preload(),
  db.syncs.preload(),
]).then(() => undefined);

export const disposeDB = exposeElectronSQLitePersistence({
  ipcMain,
  persistence,
});
