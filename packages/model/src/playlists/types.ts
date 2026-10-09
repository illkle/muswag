export interface PlaylistEntry {
  id: string;
  songId: string;
}

/** The fields a user can edit and the server stores for us. */
export interface PlaylistDetails {
  name: string;
  comment: string;
  public: boolean;
}

export interface PlaylistState extends PlaylistDetails {
  readonly: boolean;
  entries: PlaylistEntry[];
  owner?: string;
  created?: string;
  changed?: string;
  duration?: number;
  coverArt?: string;
  allowedUser?: string[];
  validUntil?: string;
}

export interface PlaylistRecord {
  id: string;
  serverId: string | null;
  /** Last state known to be on the server. `null` until the first successful push or pull. */
  base: PlaylistState | null;
  /** `null` is a tombstone awaiting deletion on the server. */
  local: PlaylistState | null;
  revision: number;
}

/** The server's view of a playlist. It has no entry ids, only an ordered list of songs. */
export type RemotePlaylist = Omit<PlaylistState, "entries"> & {
  id: string;
  songIds: string[];
};

export type RemotePlaylistMutation =
  | { type: "create"; localId: string; state: PlaylistState }
  | { type: "replace"; localId: string; serverId: string; expected: RemotePlaylist; state: PlaylistState }
  | { type: "delete"; localId: string; serverId: string };
