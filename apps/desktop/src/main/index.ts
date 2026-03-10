import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { app, BrowserWindow, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import {
  SyncManager,
  createDrizzleDb,
  getAlbumDetail,
  getAlbums,
  getSongs,
  migrateDb,
} from "@muswag/db";

import type { MuswagMainIpc, MuswagRendererIpc } from "../shared/ipc";
import { getDefaultMpvIpcPath, MpvController } from "./mpv-controller";

let sqlite: Database | undefined;
let db: ReturnType<typeof createDrizzleDb> | undefined;
let syncManager: SyncManager | undefined;
let mpvController: MpvController | undefined;

const mainIpc = new IpcListener<MuswagMainIpc>();
const rendererIpc = new IpcEmitter<MuswagRendererIpc>();

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
  sqlite.pragma("foreign_keys = ON");

  return sqlite;
}

function broadcastSyncEvent(event: MuswagRendererIpc["sync:event"][0]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "sync:event", event);
  }
}

function broadcastPlayerEvent(event: MuswagRendererIpc["player:event"][0]): void {
  logPlayerMain("broadcast:renderer", summarizePlayerEvent(event));
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "player:event", event);
  }
}

function getDrizzleDb(): ReturnType<typeof createDrizzleDb> {
  if (db) {
    return db;
  }

  db = createDrizzleDb(getDatabase());
  migrateDb(db);

  return db;
}

function getSyncManager(): SyncManager {
  if (syncManager) {
    return syncManager;
  }

  syncManager = new SyncManager(getDrizzleDb());
  syncManager.subscribe((event) => {
    broadcastSyncEvent(event);
  });

  return syncManager;
}

function getMpvController(): MpvController {
  if (mpvController) {
    return mpvController;
  }

  mpvController = new MpvController({
    getDb: getDrizzleDb,
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    mpvBinaryPath: process.env.MUSWAG_MPV_PATH ?? "mpv",
    onEvent: (event) => {
      broadcastPlayerEvent(event);
    },
  });

  return mpvController;
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

  mainIpc.handle("db:getAlbumDetail", async (_, albumId: string) => getAlbumDetail(getDrizzleDb(), albumId));
  mainIpc.handle("db:getAlbums", async () => getAlbums(getDrizzleDb()));
  mainIpc.handle("db:getSongs", async (_, input) => getSongs(getDrizzleDb(), input));
  mainIpc.handle("player:getState", async () => {
    logPlayerMain("ipc:player:getState");
    return getMpvController().getState();
  });
  mainIpc.handle("player:next", async () => {
    logPlayerMain("ipc:player:next");
    return getMpvController().next();
  });
  mainIpc.handle("player:pause", async () => {
    logPlayerMain("ipc:player:pause");
    return getMpvController().pause();
  });
  mainIpc.handle("player:play", async () => {
    logPlayerMain("ipc:player:play");
    return getMpvController().play();
  });
  mainIpc.handle("player:playQueue", async (_, input) => {
    logPlayerMain("ipc:player:playQueue", {
      queueLength: input.queue.length,
      startIndex: input.startIndex,
      startTrackId: input.queue[input.startIndex]?.id ?? null,
    });
    return getMpvController().playQueue(input);
  });
  mainIpc.handle("player:previous", async () => {
    logPlayerMain("ipc:player:previous");
    return getMpvController().previous();
  });
  mainIpc.handle("player:seek", async (_, positionSeconds) => {
    logPlayerMain("ipc:player:seek", { positionSeconds });
    return getMpvController().seek(positionSeconds);
  });
  mainIpc.handle("player:toggle", async () => {
    logPlayerMain("ipc:player:toggle");
    return getMpvController().toggle();
  });
  mainIpc.handle("sync:getUserState", async () => getSyncManager().getUserState());
  mainIpc.handle("sync:login", async (_, credentials) => getSyncManager().login(credentials));
  mainIpc.handle("sync:logout", async () => getSyncManager().logout());
  mainIpc.handle("sync:run", async () => getSyncManager().sync());

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
  mainIpc.dispose();
  mpvController?.dispose();
  mpvController = undefined;
  db = undefined;
  syncManager = undefined;
  sqlite?.close();
  sqlite = undefined;
});

function summarizePlayerEvent(event: MuswagRendererIpc["player:event"][0]): Record<string, unknown> {
  if (event.type !== "state") {
    return { type: event.type };
  }

  return {
    type: event.type,
    status: event.state.status,
    currentTrackId: event.state.currentTrack?.id ?? null,
    currentTrackTitle: event.state.currentTrack?.title ?? null,
    currentIndex: event.state.currentIndex,
    queueLength: event.state.queue.length,
    positionSeconds: roundSeconds(event.state.positionSeconds),
    durationSeconds: roundSeconds(event.state.durationSeconds),
    error: event.state.error,
  };
}

function roundSeconds(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function logPlayerMain(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.debug("[player][main]", message, payload);
    return;
  }

  console.debug("[player][main]", message);
}
