import { join, resolve } from "node:path";

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { IpcListener } from "@electron-toolkit/typed-ipc/main";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import type { MuswagMainIpc } from "#shared/ipc";
import { getDefaultMpvIpcPath } from "./player";
import { registerPlayerIpc, type PlayerHandle } from "./player/ipc";
import { startStateMirror } from "./state-mirror";
import { LibraryDatabaseError, resetLibrary, startApp, type AppOptions } from "./app";
import { initializeAutoUpdater, registerAppUpdater } from "./app-updater";
import { handleCoverProtocol, registerCoverScheme } from "./cover-protocol";
import { startDevBridge } from "./dev-bridge";
import { createWindow } from "./window";

import { Effect } from "effect";

let player: PlayerHandle | undefined;
let stateMirror: Awaited<ReturnType<typeof startStateMirror>> | undefined;
let mainApp: Awaited<ReturnType<typeof startApp>> | undefined;

// A second instance would open the same library and fight the first over the queue. Development
// checkouts run side by side on purpose, each with its own library.
const isSecondInstance = !is.dev && !app.requestSingleInstanceLock();
if (isSecondInstance) app.quit();

registerCoverScheme();

const mainIpc = new IpcListener<MuswagMainIpc>();

/**
 * Starts main's side of the app, or resolves to nothing when the app has to quit. A library database
 * that cannot be opened is offered for deletion: what it holds is on the server, or is entered again.
 */
async function startAppOrReset(options: AppOptions): Promise<Awaited<ReturnType<typeof startApp>> | undefined> {
  let reset = false;
  for (;;) {
    try {
      if (reset) await resetLibrary(options);
      return await startApp(options);
    } catch (cause) {
      console.error("Failed to start", cause);
      if (!(cause instanceof LibraryDatabaseError)) {
        dialog.showErrorBox("muswag could not start", cause instanceof Error ? cause.message : String(cause));
        return undefined;
      }
      if (!cause.resettable) {
        dialog.showErrorBox("The library database could not be opened", `${cause.databasePath}\n\n${cause.message}`);
        return undefined;
      }
      const { response } = await dialog.showMessageBox({
        type: "error",
        message: "The library database could not be opened",
        detail: `${cause.databasePath}\n\n${cause.message}\n\nThe library is a copy of what is on your server. Resetting deletes this file and the downloaded covers. You log in again, and the library is downloaded again.`,
        buttons: ["Reset library", "Quit"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return undefined;
      reset = true;
    }
  }
}

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

  const userDataPath = app.getPath("userData");
  // Covers come from the session, which is there once the app has started.
  const serveCover = handleCoverProtocol({ userDataPath, coverPath: async (owner) => mainApp?.coverPath(owner) ?? null });
  // Before any handler is registered: the bridge only knows the handlers registered after it starts.
  const devBridgePort = Number(process.env.MUSWAG_DEV_BRIDGE_PORT);
  if (is.dev && devBridgePort) startDevBridge({ ipcMain, port: devBridgePort, serveCover });

  stateMirror = await startStateMirror(ipcMain);
  registerAppUpdater(mainIpc, stateMirror.mirror);
  player = registerPlayerIpc(mainIpc, {
    ipcPath: getDefaultMpvIpcPath(app.getPath("temp")),
    settingsPath: join(userDataPath, "player-settings.json"),
    stateMirror: stateMirror.mirror,
  });
  // The library is migrated and mirrored before any window can ask for it.
  mainApp = await startAppOrReset({
    // A development checkout keeps its library next to itself, so several can run side by side.
    databasePath: is.dev ? resolve("dev-library.db") : join(userDataPath, "library.db"),
    userDataPath,
    ipcMain,
    player,
    stateMirror: stateMirror.mirror,
  });
  if (!mainApp) {
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
    allowQuit = true;
    app.quit();
  });
});
