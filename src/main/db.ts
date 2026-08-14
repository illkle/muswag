import { exposeElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence/main";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";
import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "path";
import { ipcMain } from "electron";

const dbP = process.env.NODE_ENV === "development" ? "./dev.db" : join(app.getPath("userData"), "muswag.db");

const database = new Database(dbP);

const persistence = createNodeSQLitePersistence({
  database,
  schemaMismatchPolicy: "sync-present-reset",
});

export const disposeDB = exposeElectronSQLitePersistence({
  ipcMain,
  persistence,
});
