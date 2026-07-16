import electronUpdater from "electron-updater";
import { app, dialog } from "electron";

import type { AppUpdateState } from "../shared/ipc";

const { autoUpdater } = electronUpdater;

let updateDialogShown = false;
let initialized = false;
let pendingCheck: Promise<AppUpdateState> | null = null;
const stateListeners = new Set<(state: AppUpdateState) => void>();
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
  for (const listener of stateListeners) {
    listener(getAppUpdateState());
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getAppUpdateState(): AppUpdateState {
  return { ...updateState };
}

export function subscribeToAppUpdateState(listener: (state: AppUpdateState) => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

export function checkForAppUpdates(): Promise<AppUpdateState> {
  if (!app.isPackaged) {
    return Promise.resolve(getAppUpdateState());
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
    .then(() => getAppUpdateState())
    .catch((error: unknown) => {
      console.error("Muswag auto-update check failed", error);
      setUpdateState({ error: getErrorMessage(error), status: "error" });
      return getAppUpdateState();
    })
    .finally(() => {
      pendingCheck = null;
    });

  return pendingCheck;
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

    if (updateDialogShown) {
      return;
    }

    updateDialogShown = true;
    void dialog
      .showMessageBox({
        type: "info",
        title: "Muswag update ready",
        message: "A new version of Muswag has been downloaded.",
        detail: "Restart Muswag now to install the update.",
        buttons: ["Restart and install", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (error) => {
    console.error("Muswag auto-update failed", error);
    setUpdateState({ error: getErrorMessage(error), status: "error" });
  });

  void checkForAppUpdates();
}
