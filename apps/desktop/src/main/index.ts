import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { createNodeCoverArtFileSystem } from "@muswag/shared/sync-node";
import type { MuswagRendererIpc } from "../shared/ipc";
import {
  cancelMpvInstall,
  clearManualMpvPath,
  disposePlayer,
  getDefaultMpvIpcPath,
  initializePlayer,
  installMpv,
  next,
  pause,
  play,
  playQueue,
  previous,
  refreshMpvAvailability,
  seek,
  setCredentials,
  setManualMpvPath,
  setMuted,
  setVolume,
  subscribe,
  toggle,
} from "./player/mpv-controller";
import { getMpvState, getState } from "./player/player-session";
import { disposeDB } from "./db";
import { checkForAppUpdates, getAppUpdateState, initializeAutoUpdater, subscribeToAppUpdateState } from "./app-updater";

let unsubscribePlayerEvents: (() => void) | undefined;
let unsubscribeAppUpdateState: (() => void) | undefined;

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

function broadcastMpvInstallOutput(output: MuswagRendererIpc["mpv:installOutput"][0]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "mpv:installOutput", output);
  }
}

function initializeDesktopPlayer(): void {
  initializePlayer({
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    mpvPathStatePath: join(app.getPath("userData"), "mpv.json"),
    volumeStatePath: join(app.getPath("userData"), "player-volume.json"),
  });

  if (!unsubscribePlayerEvents) {
    unsubscribePlayerEvents = subscribe((event) => {
      broadcastPlayerEvent(event);
    });
  }
}

function registerMpvIpc(): void {
  mainIpc.handle("mpv:recheck", async () => refreshMpvAvailability());
  mainIpc.handle("mpv:cancelInstall", async () => {
    cancelMpvInstall();
  });
  mainIpc.handle("mpv:clearManualPath", async () => clearManualMpvPath());
  mainIpc.handle("mpv:install", async (_, method) => {
    return installMpv(method, broadcastMpvInstallOutput);
  });
  mainIpc.handle("mpv:locate", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      buttonLabel: "Use this binary",
      message: "Select the mpv executable",
      properties: ["openFile", "showHiddenFiles", "treatPackageAsDirectory"],
      title: "Locate mpv",
    });

    const [selectedPath] = filePaths;
    if (canceled || !selectedPath) {
      return getMpvState();
    }

    return setManualMpvPath(selectedPath);
  });
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

  mainIpc.handle("appUpdate:getState", async () => getAppUpdateState());
  mainIpc.handle("appUpdate:check", async () => checkForAppUpdates());
  unsubscribeAppUpdateState = subscribeToAppUpdateState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      rendererIpc.send(window.webContents, "appUpdate:state", state);
    }
  });

  registerMpvIpc();

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
  initializeAutoUpdater();

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
  unsubscribeAppUpdateState?.();
  unsubscribeAppUpdateState = undefined;
  disposeCoverArtIpc?.();
  unsubscribePlayerEvents?.();
  unsubscribePlayerEvents = undefined;
  disposePlayer();
  disposeDB();
});
