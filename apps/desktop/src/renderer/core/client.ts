import type { AuthSnapshot, CoverTarget, LibrarySyncStatus, PlaylistSyncStatus, RefreshStatTarget, SessionCredentials, SyncMode } from "@muswag/shared";

import { appCommand, appStates, loadAppStates } from "#/lib/app-ipc";

let resolveAppReady!: () => void;
let rejectAppReady!: (cause: unknown) => void;
let startPromise: Promise<void> | undefined;

/** Resolves once main has restored the session, logged in or not. */
export const appReady = new Promise<void>((resolve, reject) => {
  resolveAppReady = resolve;
  rejectAppReady = reject;
});

const whenInitialized = () =>
  new Promise<void>((resolve) => {
    if (appStates.auth.state._tag !== "Initializing") return resolve();
    const subscription = appStates.auth.subscribe(() => {
      if (appStates.auth.state._tag === "Initializing") return;
      subscription.unsubscribe();
      resolve();
    });
  });

const subscribeTo = (store: { subscribe: (listener: () => void) => { unsubscribe: () => void } }) => (listener: () => void) => {
  const subscription = store.subscribe(listener);
  return () => subscription.unsubscribe();
};

/** The session, library sync and covers, all of which main runs. */
export const AppClient = {
  start(): Promise<void> {
    startPromise ??= loadAppStates()
      .then(whenInitialized)
      .then(resolveAppReady, (cause) => {
        rejectAppReady(cause);
        throw cause;
      });
    return startPromise;
  },

  getAuthSnapshot: (): AuthSnapshot => appStates.auth.state,
  subscribeAuth: subscribeTo(appStates.auth),

  login: (credentials: SessionCredentials) => appCommand("session:login", credentials).then(() => undefined),
  /** Main stops playback, ends the session and deletes the local library. */
  logout: () => appCommand("session:logout").then(() => undefined),

  getLibrarySyncStatus: (): LibrarySyncStatus => appStates.librarySync.state,
  subscribeLibrarySync: subscribeTo(appStates.librarySync),
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  cancelSync: () => appCommand("library:cancelSync"),
  refreshStats: (target: RefreshStatTarget) => appCommand("library:refreshStats", target),

  ensureCover: (target: CoverTarget) => appCommand("covers:ensure", target),
  repairCover: (target: CoverTarget, failedPath: string) => appCommand("covers:repair", target, failedPath),

  getPlaylistSyncStatus: (): PlaylistSyncStatus => appStates.playlistSync.state,
  subscribePlaylistSync: subscribeTo(appStates.playlistSync),
  syncPlaylists: () => appCommand("playlists:sync"),
};
