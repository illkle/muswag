import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import type { SqliteQueryRequest, SqliteQueryResponse } from "../shared/sqlite";

let sqlite: Database | undefined;

function getDatabasePath(): string {
  return join(app.getPath("userData"), "muswag.db");
}

function getDatabase(): Database {
  if (sqlite) {
    return sqlite;
  }

  const databasePath = getDatabasePath();
  mkdirSync(dirname(databasePath), { recursive: true });
  sqlite = new BetterSqlite3(databasePath);
  sqlite.pragma("journal_mode = WAL");

  return sqlite;
}

function runSqliteQuery({ sql, params, method }: SqliteQueryRequest): SqliteQueryResponse {
  const statement = getDatabase().prepare(sql);

  switch (method) {
    case "all":
    case "values":
      return { rows: statement.raw(true).all(...params) as unknown[] };
    case "get": {
      const row = statement.raw(true).get(...params);
      return { rows: row };
    }
    case "run": {
      const result = statement.run(...params);
      return {
        rows: [
          {
            changes: result.changes,
            lastInsertRowid: result.lastInsertRowid,
          },
        ],
      };
    }
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.muswag.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  ipcMain.handle("sqlite:query", async (_, request: SqliteQueryRequest) => runSqliteQuery(request));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  sqlite?.close();
  sqlite = undefined;
});
