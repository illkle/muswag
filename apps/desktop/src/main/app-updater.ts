import electronUpdater from "electron-updater";
import { app, dialog } from "electron";

const { autoUpdater } = electronUpdater;

let updateDialogShown = false;

export function initializeAutoUpdater(): void {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", () => {
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
  });

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    console.error("Muswag auto-update check failed", error);
  });
}
