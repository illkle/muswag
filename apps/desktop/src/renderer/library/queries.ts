import { IDLE_LIBRARY_SYNC, type LibrarySyncStatus } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { appState } from "#/data/app-state";
import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from "#shared/state/sync-settings";

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useSelector(appState.librarySync, (status) => status ?? IDLE_LIBRARY_SYNC);

/** When the app syncs the library on its own, as main keeps it. */
export const useSyncSettings = (): SyncSettings => useSelector(appState.syncSettings, (settings) => settings ?? DEFAULT_SYNC_SETTINGS);

/** How far a running sync has got, as a whole percentage short of 100; `null` before it knows. */
export const syncPercent = ({ progress }: LibrarySyncStatus): number | null => (progress && progress.total > 0 ? Math.min(99, Math.floor((progress.done / progress.total) * 100)) : null);
