import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

import { STATE_MIRROR_CHANNEL } from "#shared/ipc";
import { appUpdate } from "#shared/state/app-update";
import { player, playerInstallOutput, playerPosition } from "#shared/state/player";
import { auth, librarySync, playlistSync } from "#shared/state/session";

/** Main's in-memory state, mirrored over its own channel; the library has a client of its own (`library.ts`). */
export const stateClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer, channel: STATE_MIRROR_CHANNEL }) });

/** Read-only: main changes this state, renderers ask it to through commands. */
const options = { client: stateClient, defaultIndexType: BasicIndex, readOnly: true } as const;

/** The session, the sync status and the app's updates, one row each. */
export const appState = {
  auth: createCollection(mirrorCollectionOptions({ ...options, table: auth })),
  librarySync: createCollection(mirrorCollectionOptions({ ...options, table: librarySync })),
  playlistSync: createCollection(mirrorCollectionOptions({ ...options, table: playlistSync })),
  appUpdate: createCollection(mirrorCollectionOptions({ ...options, table: appUpdate })),
};

/** The player as main publishes it. Change it only through `PlayerIPC` and `MpvIPC`. */
export const playerState = {
  player: createCollection(mirrorCollectionOptions({ ...options, table: player })),
  position: createCollection(mirrorCollectionOptions({ ...options, table: playerPosition })),
  installOutput: createCollection(mirrorCollectionOptions({ ...options, table: playerInstallOutput })),
};
