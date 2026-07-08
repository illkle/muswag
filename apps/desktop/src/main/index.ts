import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { createNodeCoverArtFileSystem } from "@muswag/shared/sync-node";
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
  setCredentials,
  setMuted,
  setVolume,
  subscribe,
  toggle,
} from "./player/mpv-controller";
import { getState } from "./player/player-session";
import { disposeDB } from "./db";

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
let disposeCoverArtIpc: (() => void) | undefined;

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
    volumeStatePath: join(app.getPath("userData"), "player-volume.json"),
  });

  if (!unsubscribePlayerEvents) {
    unsubscribePlayerEvents = subscribe((event) => {
      broadcastPlayerEvent(event);
    });
  }
}

function registerCoverArtIpc(): void {
  if (disposeCoverArtIpc) {
    return;
  }

  const coverArtFileSystem = createNodeCoverArtFileSystem(join(app.getPath("userData"), "cover-art"));

  ipcMain.handle("coverArt:removeFiles", async (_, albumId: string) => {
    await coverArtFileSystem.removeCoverFiles(albumId);
  });
  ipcMain.handle("coverArt:writeFile", async (_, albumId: string, extension: string, bytes: Uint8Array) => {
    return coverArtFileSystem.writeCoverFile(albumId, extension, bytes);
  });

  disposeCoverArtIpc = () => {
    ipcMain.removeHandler("coverArt:removeFiles");
    ipcMain.removeHandler("coverArt:writeFile");
    disposeCoverArtIpc = undefined;
  };
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

  registerCoverArtIpc();

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
  mainIpc.handle("player:setCredentials", async (_, credentials) => {
    setCredentials(credentials);
  });
  mainIpc.handle("player:setMuted", async (_, muted) => {
    await setMuted(muted);
  });
  mainIpc.handle("player:setVolume", async (_, volumePercent) => {
    await setVolume(volumePercent);
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
  disposeCoverArtIpc?.();
  unsubscribePlayerEvents?.();
  unsubscribePlayerEvents = undefined;
  disposePlayer();
  disposeDB();
});
