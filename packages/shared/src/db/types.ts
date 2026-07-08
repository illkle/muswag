export interface UserCredentials {
  id: number;
  url: string;
  username: string;
  password: string;
}

export type SyncStatus = "running" | "completed" | "failed" | "aborted";

export type SyncStep =
  | "starting"
  | "fetching-album-list"
  | "fetching-album-details"
  | "saving-albums"
  | "removing-missing-albums"
  | "removing-dangling-songs"
  | "removing-cover-art"
  | "completed"
  | "failed"
  | "aborted";

export interface SyncProgress {
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
}

export interface SyncRecord {
  id: string;
  timeStarted: string;
  timeEnded: string | null;
  lastStatus: SyncStatus;
  error: string | null;
  currentStep?: SyncStep;
  progress?: SyncProgress;
  progressUpdatedAt?: string;
}
