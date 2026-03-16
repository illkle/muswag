import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { SyncManager, getAlbumDetail, getAlbums, getSongById, getSongs } from "@muswag/shared";

import type { MuswagMainIpc, MuswagRendererIpc } from "../shared/ipc";
import { getDefaultMpvIpcPath, MpvController } from "./mpv-controller";
import { closeDb, getDrizzleDb } from "./drizzleSqlite";

let syncManager: SyncManager | undefined;
let mpvController: MpvController | undefined;

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

const mainIpc = new IpcListener<MuswagMainIpc>();
const rendererIpc = new IpcEmitter<MuswagRendererIpc>();

function getCoverArtDirectory(): string {
  return join(app.getPath("userData"), "album-covers");
}

function broadcastSyncEvent(event: MuswagRendererIpc["sync:event"][0]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "sync:event", event);
  }
}

function broadcastPlayerEvent(event: MuswagRendererIpc["player:event"][0]): void {
  console.log("broadcast:renderer", event);
  for (const window of BrowserWindow.getAllWindows()) {
    rendererIpc.send(window.webContents, "player:event", event);
  }
}

function getSyncManager(): SyncManager {
  if (syncManager) {
    return syncManager;
  }

  syncManager = new SyncManager(getDrizzleDb(), {
    coverArtDir: getCoverArtDirectory(),
  });
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

  mainIpc.handle("db:getAlbumDetail", async (_, albumId: string) =>
    getAlbumDetail(getDrizzleDb(), albumId),
  );
  mainIpc.handle("db:getAlbums", async () => getAlbums(getDrizzleDb()));
  mainIpc.handle("db:getSongById", async (_, songId: string) =>
    getSongById(getDrizzleDb(), songId),
  );
  mainIpc.handle("db:getSongs", async (_, input) => getSongs(getDrizzleDb(), input));
  mainIpc.handle("player:getState", async () => {
    return getMpvController().getState();
  });
  mainIpc.handle("player:next", async () => {
    return getMpvController().next();
  });
  mainIpc.handle("player:pause", async () => {
    return getMpvController().pause();
  });
  mainIpc.handle("player:play", async () => {
    return getMpvController().play();
  });
  mainIpc.handle("player:playQueue", async (_, input) => {
    return getMpvController().playQueue(input);
  });
  mainIpc.handle("player:previous", async () => {
    return getMpvController().previous();
  });
  mainIpc.handle("player:seek", async (_, positionSeconds) => {
    return getMpvController().seek(positionSeconds);
  });
  mainIpc.handle("player:toggle", async () => {
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
  app.quit();
});

app.on("before-quit", () => {
  mainIpc.dispose();
  mpvController?.dispose();
  mpvController = undefined;
  syncManager = undefined;
  closeDb();
});
