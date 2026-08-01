import { useEffect, useState } from "react";

import { AppUpdateIPC } from "#/lib/ipc";
import type { AppUpdateState, AppUpdateStatus } from "#shared/ipc";

/** Mirrors the main process update state, which changes on its own while a download runs. */
export function useAppUpdate(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = AppUpdateIPC.subscribe(setState);

    void AppUpdateIPC.getState().then((nextState) => {
      if (active) {
        setState(nextState);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

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
