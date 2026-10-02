/** Types exchanged between main, which owns the library, and the renderer. */

export interface SessionCredentials {
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export type AuthSnapshot = { readonly _tag: "Initializing" } | { readonly _tag: "LoggedOut" } | { readonly _tag: "LoggedIn"; readonly url: string; readonly username: string };

export type SyncMode = "full" | "quick";

export interface LibrarySyncStatus {
  /** The mode of the sync that is running, or `null` when idle. */
  readonly running: SyncMode | null;
  readonly error: string | null;
  readonly lastSyncedAt: string | null;
}

export interface PlaylistSyncStatus {
  state: "idle" | "scheduled" | "syncing" | "paused" | "error";
  error: string | null;
  lastSyncedAt: string | null;
}

export type RefreshStatTarget = { type: "album" | "playlist"; id: string };

export type CoverTarget = { type: "album"; id: string; coverArtId: string | null } | { type: "artist"; id: string; coverArtId: string | null };

export interface CreatePlaylistInput {
  name: string;
  comment?: string;
  public?: boolean;
  songIds?: string[];
}
