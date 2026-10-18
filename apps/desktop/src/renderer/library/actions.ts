import type { RefreshTarget, SyncMode } from "@muswag/model";

import { appCommand } from "#/data/app-command";

/** Library sync and page refreshes, both of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
  refresh: (target: RefreshTarget) => appCommand("library:refresh", target),
  /** Where an artist appears on other artists' albums, which main finds in the credits of every song. */
  artistAppearances: (artistId: string) => appCommand("library:artistAppearances", artistId),
};
