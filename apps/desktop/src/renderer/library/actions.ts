import type { CoverTarget, RefreshStatTarget, SyncMode } from "@muswag/model";

import { appCommand } from "#/data/app-command";

/** Library sync, play stats and cover art, all of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  refreshStats: (target: RefreshStatTarget) => appCommand("library:refreshStats", target),

  ensureCover: (target: CoverTarget) => appCommand("covers:ensure", target),
  repairCover: (target: CoverTarget, failedPath: string) => appCommand("covers:repair", target, failedPath),
};
