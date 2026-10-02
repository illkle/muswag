import type { CoverTarget, RefreshStatTarget, SessionCredentials, SyncMode } from "@muswag/model";

import { appCommand } from "#/lib/app-ipc";
import { appState } from "#/lib/state-mirror";

let startPromise: Promise<void> | undefined;

/** Whether main has restored the session, logged in or not. */
const initialized = () => {
  const row = appState.auth.get("auth");
  return row !== undefined && row.value._tag !== "Initializing";
};

const whenInitialized = () =>
  new Promise<void>((resolve) => {
    if (initialized()) return resolve();
    const subscription = appState.auth.subscribeChanges(() => {
      if (!initialized()) return;
      subscription.unsubscribe();
      resolve();
    });
  });

/** The session, library sync and covers, all of which main runs. Their state is in `appState`. */
export const AppClient = {
  /** Resolves once main has restored the session, logged in or not. */
  start(): Promise<void> {
    startPromise ??= appState.auth.preload().then(whenInitialized);
    return startPromise;
  },

  login: (credentials: SessionCredentials) => appCommand("session:login", credentials).then(() => undefined),
  /** Main stops playback, ends the session and deletes the local library. */
  logout: () => appCommand("session:logout").then(() => undefined),

  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  cancelSync: () => appCommand("library:cancelSync"),
  refreshStats: (target: RefreshStatTarget) => appCommand("library:refreshStats", target),

  ensureCover: (target: CoverTarget) => appCommand("covers:ensure", target),
  repairCover: (target: CoverTarget, failedPath: string) => appCommand("covers:repair", target, failedPath),

  syncPlaylists: () => appCommand("playlists:sync"),
};
