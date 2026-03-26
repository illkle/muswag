import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import Database from "better-sqlite3";
import type { MuswagRendererIpc } from "../shared/ipc";
import {
  disposePlayer,
  getDefaultMpvIpcPath,
  initializePlayer,
  next,
  pause,
  play,
  playQueue,
  previous,
  seek,
  subscribe,
  toggle,
} from "./player/mpv-controller";
import { getState } from "./player/player-session";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";
import { exposeElectronSQLitePersistence } from "@tanstack/electron-db-sqlite-persistence/main";

const dbP = join(app.getPath("userData"), "muswag.db");

const database = new Database(dbP);

const persistence = createNodeSQLitePersistence({
  database,
});

let unsubscribePlayerEvents: (() => void) | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "muswag-cover",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const mainIpc = new IpcListener();
const rendererIpc = new IpcEmitter<MuswagRendererIpc>();

const dispose = exposeElectronSQLitePersistence({
  ipcMain: mainIpc,
  persistence,
});

function broadcastPlayerEvent(event: MuswagRendererIpc["player:event"][0]): void {
  console.log("broadcast:renderer", event);
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "player:event", event);
  }
}

function initializeDesktopPlayer(): void {
  initializePlayer({
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    mpvBinaryPath: process.env.MUSWAG_MPV_PATH ?? "mpv",
  });

  if (!unsubscribePlayerEvents) {
    unsubscribePlayerEvents = subscribe((event) => {
      broadcastPlayerEvent(event);
    });
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minHeight: 600,
    minWidth: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
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

  protocol.handle("muswag-cover", (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) {
      return new Response("Missing path", { status: 400 });
    }

    return net.fetch(pathToFileURL(requestedPath).toString());
  });

  mainIpc.handle("player:getState", async () => {
    return getState();
  });
  mainIpc.handle("player:next", async () => {
    await next();
  });
  mainIpc.handle("player:pause", async () => {
    await pause();
  });
  mainIpc.handle("player:play", async () => {
    await play();
  });
  mainIpc.handle("player:playQueue", async (_, input) => {
    await playQueue(input);
  });
  mainIpc.handle("player:previous", async () => {
    await previous();
  });
  mainIpc.handle("player:seek", async (_, positionSeconds) => {
    await seek(positionSeconds);
  });
  mainIpc.handle("player:toggle", async () => {
    await toggle();
  });

  initializeDesktopPlayer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  mainIpc.dispose();
  unsubscribePlayerEvents?.();
  unsubscribePlayerEvents = undefined;
  disposePlayer();
});
