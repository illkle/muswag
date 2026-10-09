import { useLiveQuery } from "@tanstack/react-db";

import { mainIpc } from "#/data/ipc";
import { appState } from "#/data/state";
import type { AppUpdateState, AppUpdateStatus } from "#shared/state/app-update";

export const AppUpdateIPC = {
  check: () => mainIpc.invoke("appUpdate:check"),
  install: () => mainIpc.invoke("appUpdate:install"),
};

/** The update state, which main changes on its own while a check or a download runs. Null until it has arrived. */
export const useAppUpdate = (): AppUpdateState | null => useLiveQuery((q) => q.from({ update: appState.appUpdate }).findOne()).data?.value ?? null;

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
