import { IDLE_LIBRARY_SYNC, type LibrarySyncStatus } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";

import { appState } from "#/data/state";

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useLiveQuery((q) => q.from({ status: appState.librarySync }).findOne()).data?.value ?? IDLE_LIBRARY_SYNC;
