import { IDLE_LIBRARY_SYNC, type LibrarySyncStatus } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { appState } from "#/data/state";
import { rowStore } from "#/data/stores";

const librarySyncRow = rowStore(appState.librarySync, "library_sync");

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useSelector(librarySyncRow, (row) => row?.value ?? IDLE_LIBRARY_SYNC);
