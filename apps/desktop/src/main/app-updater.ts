import electronUpdater from "electron-updater";
import { app } from "electron";
import type { IpcListener } from "@electron-toolkit/typed-ipc/main";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { Effect } from "effect";

import type { MuswagMainIpc } from "#shared/ipc";
import { appUpdate, type AppUpdateState } from "#shared/state/app-update";

const { autoUpdater } = electronUpdater;

let initialized = false;
let pendingCheck: Promise<void> | null = null;
/** Shows renderers the state; set by `registerAppUpdater`. */
let publish: (state: AppUpdateState) => void = () => {};
let updateState: AppUpdateState = {
  canCheck: app.isPackaged,
  currentVersion: app.getVersion(),
  error: null,
  latestVersion: null,
  lastCheckedAt: null,
  progressPercent: null,
  status: app.isPackaged ? "idle" : "disabled",
};

function setUpdateState(patch: Partial<AppUpdateState>): void {
  updateState = { ...updateState, ...patch };
  publish(updateState);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkForAppUpdates(): Promise<void> {
  if (!app.isPackaged) {
    return Promise.resolve();
  }

  if (pendingCheck) {
    return pendingCheck;
  }

  setUpdateState({
    error: null,
    lastCheckedAt: new Date().toISOString(),
    progressPercent: null,
    status: "checking",
  });

  pendingCheck = autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error("Muswag auto-update check failed", error);
      setUpdateState({ error: getErrorMessage(error), status: "error" });
    })
    .finally(() => {
      pendingCheck = null;
    });

  return pendingCheck;
}

function installAppUpdate(): void {
  if (updateState.status !== "ready") {
    return;
  }

  autoUpdater.quitAndInstall();
}

export function initializeAutoUpdater(): void {
  if (initialized || !app.isPackaged) {
    return;
  }

  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ error: null, progressPercent: null, status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({ latestVersion: info.version, status: "downloading" });
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({ latestVersion: info.version, progressPercent: null, status: "up-to-date" });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({ progressPercent: Math.round(progress.percent), status: "downloading" });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({ latestVersion: info.version, progressPercent: 100, status: "ready" });
  });

  autoUpdater.on("error", (error) => {
    console.error("Muswag auto-update failed", error);
    setUpdateState({ error: getErrorMessage(error), status: "error" });
  });

  void checkForAppUpdates();
}

/**
 * Shows renderers the update state in `state`, which must mirror `appUpdate`, and answers their
 * requests to check and to install.
 */
export function registerAppUpdater(mainIpc: IpcListener<MuswagMainIpc>, state: MemoryMirrorService): void {
  publish = (value) => void Effect.runFork(state.upsert(appUpdate, { id: "app_update", value }));
  publish(updateState);
  mainIpc.handle("appUpdate:check", () => checkForAppUpdates());
  mainIpc.handle("appUpdate:install", async () => {
    installAppUpdate();
  });
}
