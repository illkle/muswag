import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import { createPlayer, getDefaultMpvIpcPath, type Player } from "./player";
import { disposeDB } from "./db";
import { checkForAppUpdates, getAppUpdateState, initializeAutoUpdater, installAppUpdate, subscribeToAppUpdateState } from "./app-updater";

import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Path } from "effect/Path";

import * as NodePath from "@effect/platform-node/NodePath";

let unsubscribePlayerEvents: (() => void) | undefined;
let unsubscribeAppUpdateState: (() => void) | undefined;
let player: Player | undefined;
const moduleDirectory = __dirname;

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
  if (player) return;
  player = createPlayer({
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    mpvPathStatePath: join(app.getPath("userData"), "mpv.json"),
    volumeStatePath: join(app.getPath("userData"), "player-volume.json"),
  });

  if (!unsubscribePlayerEvents) {
    unsubscribePlayerEvents = player.subscribe((event) => {
      broadcastPlayerEvent(event);
    });
  }
}

function registerMpvIpc(): void {
  mainIpc.handle("mpv:recheck", async () => getPlayer().refreshMpvAvailability());
  mainIpc.handle("mpv:cancelInstall", async () => {
    getPlayer().cancelMpvInstall();
  });
  mainIpc.handle("mpv:clearManualPath", async () => getPlayer().clearManualMpvPath());
  mainIpc.handle("mpv:install", async (_, method) => {
    return getPlayer().installMpv(method, broadcastMpvInstallOutput);
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
      return getPlayer().getMpvState();
    }

    return getPlayer().setManualMpvPath(selectedPath);
  });
}

const regIpcFs = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const pathModule = yield* Path;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const basePath = app.getPath("userData");

  const makePathInUserSpace = (requestedPath: string) => {
    const absoluteBase = resolve(basePath);
    const target = resolve(absoluteBase, requestedPath);
    if (!target.startsWith(`${absoluteBase}${sep}`) && target !== absoluteBase) {
      throw new Error("Filesystem path escapes the application data directory");
    }
    return target;
  };

  mainIpc.handle("fs:write", async (_, path: string, data: Uint8Array) => {
    const target = makePathInUserSpace(path);
    return runPromise(fs.makeDirectory(pathModule.dirname(target), { recursive: true }).pipe(Effect.andThen(fs.writeFile(target, data))));
  });

  mainIpc.handle("fs:delete", async (_, path: string) => {
    // todo: pass errors
    await runPromise(Effect.exit(fs.remove(makePathInUserSpace(path))));
  });

  // todo: dispose
});

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
      preload: join(moduleDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      focusOnNavigation: process.env.NODE_ENV !== "development",
    },
  });

  mainWindow.once("ready-to-show", () => {
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

  mainWindow.loadFile(join(moduleDirectory, "../renderer/index.html"));
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

    const userDataPath = resolve(app.getPath("userData"));
    const absolutePath = resolve(userDataPath, requestedPath);
    if (!absolutePath.startsWith(`${userDataPath}${sep}`) && absolutePath !== userDataPath) {
      return new Response("Invalid path", { status: 400 });
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });

  Effect.runSync(regIpcFs.pipe(Effect.provide([NodeFileSystem.layer, NodePath.layer])));

  mainIpc.handle("appUpdate:getState", async () => getAppUpdateState());
  mainIpc.handle("appUpdate:check", async () => checkForAppUpdates());
  mainIpc.handle("appUpdate:install", async () => {
    installAppUpdate();
  });
  unsubscribeAppUpdateState = subscribeToAppUpdateState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      rendererIpc.send(window.webContents, "appUpdate:state", state);
    }
  });

  registerMpvIpc();

  mainIpc.handle("player:getState", async () => {
    return getPlayer().getState();
  });
  mainIpc.handle("player:applyQueue", async (_, input) => {
    await getPlayer().applyQueue(input);
  });
  mainIpc.handle("player:pause", async () => {
    await getPlayer().pause();
  });
  mainIpc.handle("player:play", async () => {
    await getPlayer().play();
  });
  mainIpc.handle("player:restartCurrent", async () => {
    await getPlayer().restartCurrent();
  });
  mainIpc.handle("player:stop", async () => {
    await getPlayer().stop();
  });
  mainIpc.handle("player:seek", async (_, positionSeconds) => {
    await getPlayer().seek(positionSeconds);
  });
  mainIpc.handle("player:setCredentials", async (_, credentials) => {
    await getPlayer().setCredentials(credentials);
  });
  mainIpc.handle("player:setMuted", async (_, muted) => {
    await getPlayer().setMuted(muted);
  });
  mainIpc.handle("player:setVolume", async (_, volumePercent) => {
    await getPlayer().setVolume(volumePercent);
  });
  mainIpc.handle("player:toggle", async () => {
    await getPlayer().toggle();
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
  unsubscribePlayerEvents?.();
  unsubscribePlayerEvents = undefined;
  player?.dispose();
  player = undefined;
  disposeDB();
});

function getPlayer(): Player {
  if (!player) throw new Error("Desktop player has not been initialized.");
  return player;
}
