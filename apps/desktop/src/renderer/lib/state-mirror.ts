import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

import { auth, librarySync, playlistSync } from "#shared/state/session";
import { STATE_MIRROR_CHANNEL } from "#shared/state/mirror";

/** Main's in-memory state, mirrored over its own channel; the library has a client of its own (`db-renderer`). */
export const stateClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer, channel: STATE_MIRROR_CHANNEL }) });

/** Read-only: main changes this state, renderers ask it to through commands. */
export const stateCollectionOptions = { client: stateClient, defaultIndexType: BasicIndex, readOnly: true } as const;

/** The session and sync status, one row each. The player's tables are in `#/player/connection`. */
export const appState = {
  auth: createCollection(mirrorCollectionOptions({ ...stateCollectionOptions, table: auth })),
  librarySync: createCollection(mirrorCollectionOptions({ ...stateCollectionOptions, table: librarySync })),
  playlistSync: createCollection(mirrorCollectionOptions({ ...stateCollectionOptions, table: playlistSync })),
};
