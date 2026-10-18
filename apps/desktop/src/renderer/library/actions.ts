import type { RefreshStatTarget, SyncMode } from "@muswag/model";

import { appCommand } from "#/data/app-command";

/** Library sync and play stats, both of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  refreshStats: (target: RefreshStatTarget) => appCommand("library:refreshStats", target),
  /** Where an artist appears on other artists' albums, which main finds in the credits of every song. */
  artistAppearances: (artistId: string) => appCommand("library:artistAppearances", artistId),
};
