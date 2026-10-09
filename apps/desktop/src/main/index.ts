import { join } from "node:path";

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { IpcEmitter, IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import type { MuswagMainIpc, MuswagRendererIpc } from "#shared/ipc";
import { getDefaultMpvIpcPath } from "./player";
import { registerPlayerIpc, type PlayerHandle } from "./player/ipc";
import { startStateMirror } from "./state-mirror";
import { startApp } from "./app";
import { initializeAutoUpdater, registerAppUpdateIpc } from "./app-updater";
import { handleCoverProtocol, registerCoverScheme } from "./cover-protocol";
import { startDevBridge } from "./dev-bridge";
import { createWindow } from "./window";

import { Effect } from "effect";

let unsubscribeAppUpdateState: (() => void) | undefined;
let player: PlayerHandle | undefined;
let stateMirror: Awaited<ReturnType<typeof startStateMirror>> | undefined;
let mainApp: Awaited<ReturnType<typeof startApp>> | undefined;

// A second instance would open the same library and fight the first over the queue. Development
// checkouts run side by side on purpose, each with its own library.
const isSecondInstance = !is.dev && !app.requestSingleInstanceLock();
if (isSecondInstance) app.quit();

registerCoverScheme();

const mainIpc = new IpcListener<MuswagMainIpc>();
const rendererIpc = new IpcEmitter<MuswagRendererIpc>();

app.on("second-instance", () => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(async () => {
  if (isSecondInstance) return;
  electronApp.setAppUserModelId("com.muswag.desktop");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  const serveCover = handleCoverProtocol(app.getPath("userData"));
  // Before any handler is registered: the bridge only knows the handlers registered after it starts.
  const devBridgePort = Number(process.env.MUSWAG_DEV_BRIDGE_PORT);
  if (is.dev && devBridgePort) startDevBridge({ ipcMain, port: devBridgePort, serveCover });
  unsubscribeAppUpdateState = registerAppUpdateIpc(mainIpc, rendererIpc);

  stateMirror = await startStateMirror(ipcMain);
  player = registerPlayerIpc(mainIpc, {
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    settingsPath: join(app.getPath("userData"), "player-settings.json"),
    stateMirror: stateMirror.mirror,
  });
  // The library is migrated and mirrored before any window can ask for it.
  try {
    mainApp = await startApp({
      databasePath: process.env.NODE_ENV === "development" ? "./dev-library.db" : join(app.getPath("userData"), "library.db"),
      userDataPath: app.getPath("userData"),
      ipcMain,
      mainIpc,
      player,
      stateMirror: stateMirror.mirror,
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
      // The player first and on its own: mpv is a separate process, and would play on without a
      // window if anything before it failed or ran into the deadline.
      await player?.shutdown().catch((cause) => console.error("Failed to shut the player down", cause));
      await mainApp?.dispose();
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
