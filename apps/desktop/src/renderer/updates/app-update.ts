import { useSelector } from "@tanstack/react-store";

import { appCommand } from "#/data/app-command";
import { appState } from "#/data/app-state";
import type { AppUpdateState, AppUpdateStatus, UpdateChannel } from "#shared/state/app-update";

export const AppUpdateIPC = {
  check: () => appCommand("appUpdate:check"),
  install: () => appCommand("appUpdate:install"),
  setChannel: (channel: UpdateChannel) => appCommand("appUpdate:setChannel", channel),
};

/** The update state, which main changes on its own while a check or a download runs. Null until it has arrived. */
export const useAppUpdate = (): AppUpdateState | null => useSelector(appState.appUpdate, (state) => state ?? null);

export function getAppUpdateStatus(state: AppUpdateState | null): AppUpdateStatus {
  return state?.status ?? "idle";
}

/** True while the main process is doing update work the user should not interrupt. */
export function isAppUpdateBusy(status: AppUpdateStatus): boolean {
  return status === "checking" || status === "downloading";
}

/** True when there is a newer version to tell the user about. */
export function hasAppUpdate(status: AppUpdateStatus): boolean {
  return status === "downloading" || status === "ready";
}
