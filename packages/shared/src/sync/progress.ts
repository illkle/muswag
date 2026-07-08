import type { MuswagDb } from "../db/database.js";
import type { SyncProgress, SyncStep } from "../db/types.js";

export function createInitialSyncProgress(): SyncProgress {
  return {
    pagesFetched: 0,
    albumsFetched: 0,
    currentPage: 0,
    currentPageSize: 0,
    currentPageAlbumDetailsFetched: 0,
    currentPageAlbumDetailsTotal: 0,
    albumsInserted: 0,
    albumsUpdated: 0,
    albumsDeleted: 0,
    songsDeleted: 0,
    coverArtDeleted: 0,
  };
}

export function updateSyncProgress(
  db: MuswagDb,
  syncId: string,
  update: {
    currentStep?: SyncStep;
    progress?: Partial<SyncProgress>;
  },
): void {
  const record = db.syncs.get(syncId);
  if (!record || record.timeEnded !== null) {
    return;
  }

  db.syncs.update(syncId, (draft) => {
    if (update.currentStep) {
      draft.currentStep = update.currentStep;
    }
    if (update.progress) {
      draft.progress = {
        ...createInitialSyncProgress(),
        ...draft.progress,
        ...update.progress,
      };
    }
    draft.progressUpdatedAt = new Date().toISOString();
  });
}
