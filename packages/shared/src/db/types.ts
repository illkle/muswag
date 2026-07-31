export interface UserCredentials {
  id: number;
  url: string;
  username: string;
  password: string;
}

export type SyncStatus = "running" | "completed" | "failed" | "aborted";

export type SyncStep =
  | "starting"
  | "fetching-artists"
  | "saving-artists"
  | "fetching-album-list"
  | "fetching-album-details"
  | "saving-albums"
  | "removing-missing-albums"
  | "removing-dangling-songs"
  | "removing-cover-art"
  | "fetching-cover-art"
  | "skipped-unchanged"
  | "completed"
  | "failed"
  | "aborted";

export interface SyncProgress {
  artistsFetched: number;
  artistsInserted: number;
  artistsDeleted: number;
  pagesFetched: number;
  albumsFetched: number;
  currentPage: number;
  currentPageSize: number;
  currentPageAlbumDetailsFetched: number;
  currentPageAlbumDetailsTotal: number;
  albumsInserted: number;
  albumsUpdated: number;
  albumsDeleted: number;
  songsDeleted: number;
  coverArtDeleted: number;
  coverArtFetched: number;
  coverArtTotal: number;
}

export interface SyncRecord {
  id: string;
  timeStarted: string;
  timeEnded: string | null;
  lastStatus: SyncStatus;
  error: string | null;
  mode: "full" | "quick";
  currentStep?: SyncStep;
  progress?: SyncProgress;
  progressUpdatedAt?: string;
}

export interface SyncState {
  id: number;
  indexesLastModified: number | null;
  lastFullSyncAt: string | null;
  lastQuickSyncAt: string | null;
}
