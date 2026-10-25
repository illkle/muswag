import { IDLE_LIBRARY_SYNC, type LibrarySyncStatus } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { appState } from "#/data/app-state";

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useSelector(appState.librarySync, (status) => status ?? IDLE_LIBRARY_SYNC);
