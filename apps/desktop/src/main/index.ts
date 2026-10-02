import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import { getDefaultMpvIpcPath } from "./player";
import { registerPlayerIpc } from "./player-ipc";
import { startStateMirror } from "./state-mirror";
import { startBackend } from "./backend";
import { resolveInside } from "./backend/platform";
import { checkForAppUpdates, getAppUpdateState, initializeAutoUpdater, installAppUpdate, subscribeToAppUpdateState } from "./app-updater";

import { Effect } from "effect";

let unsubscribeAppUpdateState: (() => void) | undefined;
let player: ReturnType<typeof registerPlayerIpc> | undefined;
let stateMirror: Awaited<ReturnType<typeof startStateMirror>> | undefined;
let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId("com.muswag.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  protocol.handle("muswag-cover", (request) => {
    const requestedPath = new URL(request.url).searchParams.get("path");
    if (!requestedPath) {
      return new Response("Missing path", { status: 400 });
    }

    let absolutePath: string;
    try {
      absolutePath = resolveInside(app.getPath("userData"), requestedPath);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });

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

  stateMirror = await startStateMirror(ipcMain);
  player = registerPlayerIpc(mainIpc, {
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    settingsPath: join(app.getPath("userData"), "player-settings.json"),
    stateMirror: stateMirror.mirror,
  });
  // The library is migrated and mirrored before any window can ask for it.
  try {
    backend = await startBackend({
      databasePath: process.env.NODE_ENV === "development" ? "./dev-library.db" : join(app.getPath("userData"), "library.db"),
      userDataPath: app.getPath("userData"),
      ipcMain,
      mainIpc,
      rendererIpc,
      player,
    });
  } catch (cause) {
    console.error("Failed to open the library database", cause);
    dialog.showErrorBox("muswag could not start", `The library database could not be opened.\n\n${cause instanceof Error ? cause.message : String(cause)}`);
    app.quit();
    return;
  }
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

let allowQuit = false;
let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (allowQuit) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void Effect.runPromise(
    Effect.tryPromise(async () => {
      await backend?.dispose();
      await player?.shutdown();
      await stateMirror?.dispose();
    }).pipe(
      Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.logWarning("Desktop shutdown deadline reached") }),
      Effect.catch(() => Effect.logError("Desktop shutdown failed")),
    ),
  ).finally(() => {
    mainIpc.dispose();
    unsubscribeAppUpdateState?.();
    allowQuit = true;
    app.quit();
  });
});
