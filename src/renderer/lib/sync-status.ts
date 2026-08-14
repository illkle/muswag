import type { SyncProgress, SyncRecord, SyncStep } from "#core";
import { formatDistanceStrict } from "date-fns";

export const syncStepLabels: Record<SyncStep, string> = {
  starting: "Starting sync",
  "fetching-artists": "Fetching artists",
  "saving-artists": "Saving artists",
  "fetching-album-list": "Fetching album page",
  "fetching-album-details": "Fetching album details",
  "saving-albums": "Saving albums",
  "removing-missing-albums": "Removing missing albums",
  "removing-dangling-songs": "Removing dangling songs",
  "removing-cover-art": "Removing cover art",
  "fetching-cover-art": "Fetching cover art",
  "skipped-unchanged": "Library unchanged",
  completed: "Completed",
  failed: "Failed",
  aborted: "Aborted",
};

/** The sync the user cares about: the one that started most recently. */
export function getLatestSync(syncRecords: readonly SyncRecord[] | undefined): SyncRecord | null {
  return (syncRecords ?? []).reduce<SyncRecord | null>((latest, syncRecord) => {
    return !latest || syncRecord.timeStarted > latest.timeStarted ? syncRecord : latest;
  }, null);
}

export function isSyncRunning(syncRecord: SyncRecord | null): boolean {
  return syncRecord?.lastStatus === "running";
}

export function getSyncStepLabel(syncRecord: SyncRecord): string {
  return syncRecord.currentStep ? syncStepLabels[syncRecord.currentStep] : syncRecord.lastStatus;
}

/**
 * How far along the current step is, or null when the step reports no countable work.
 * Album detail fetching dominates a sync, so it wins over the cover art pass.
 */
export function getSyncProgressPercent(progress: SyncProgress | undefined): number | null {
  if (!progress) {
    return null;
  }

  if (progress.currentPageAlbumDetailsTotal > 0) {
    return toPercent(progress.currentPageAlbumDetailsFetched, progress.currentPageAlbumDetailsTotal);
  }

  if (progress.coverArtTotal > 0) {
    return toPercent(progress.coverArtFetched, progress.coverArtTotal);
  }

  return null;
}

/** One line of sync state, short enough for the server button's menu row. */
export function getSyncSummaryLine(syncRecord: SyncRecord | null, now: Date = new Date()): string {
  if (!syncRecord) {
    return "Never synced";
  }

  switch (syncRecord.lastStatus) {
    case "running": {
      const percent = getSyncProgressPercent(syncRecord.progress);
      const label = getSyncStepLabel(syncRecord);
      return percent === null ? label : `${label} · ${percent}%`;
    }
    case "failed":
      return "Last sync failed";
    case "aborted":
      return "Last sync cancelled";
    case "completed":
      return `Synced ${formatDistanceStrict(new Date(syncRecord.timeEnded ?? syncRecord.timeStarted), now, { addSuffix: true })}`;
  }
}

export function formatSyncTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toPercent(done: number, total: number): number {
  return Math.min(100, Math.round((done / total) * 100));
}
