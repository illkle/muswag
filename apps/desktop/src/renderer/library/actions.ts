import type { RefreshStatTarget, SyncMode } from "@muswag/model";

import { appCommand } from "#/data/app-command";

/** Library sync and play stats, both of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  refreshStats: (target: RefreshStatTarget) => appCommand("library:refreshStats", target),
};
