import { useMutation } from "@tanstack/react-query";
import { useMemo } from "react";

import { getErrorMessage } from "#/lib/err";
import { useSyncs } from "#/lib/queries";
import { SyncManager } from "#/lib/sync-manager";
import { getLatestSync, isSyncRunning } from "#/lib/sync-status";
import type { SyncMode, SyncRecord } from "@muswag/shared";

export interface SyncControls {
  latestSync: SyncRecord | null;
  /** True from the moment the user asks for a sync until the record stops reporting `running`. */
  running: boolean;
  cancelling: boolean;
  error: string | null;
  startSync: (mode: SyncMode) => void;
  cancelSync: () => void;
}

/**
 * Call this once per subtree and pass the result down: the mutation state that backs
 * `error` lives in the hook, so separate callers would each see a different error.
 */
export function useSyncControls(): SyncControls {
  const syncsQuery = useSyncs();

  const latestSync = useMemo(() => getLatestSync(syncsQuery.data), [syncsQuery.data]);

  const syncMutation = useMutation({
    mutationFn: (mode: SyncMode) => SyncManager.sync({ mode }),
  });
  const cancelSyncMutation = useMutation({
    mutationFn: () => SyncManager.cancelSync(),
  });

  return {
    latestSync,
    running: isSyncRunning(latestSync) || syncMutation.isPending,
    cancelling: cancelSyncMutation.isPending,
    error: syncMutation.isError ? getErrorMessage(syncMutation.error, "The library could not be synced.") : null,
    startSync: syncMutation.mutate,
    cancelSync: cancelSyncMutation.mutate,
  };
}
