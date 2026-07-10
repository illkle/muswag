export interface PlaylistEntry {
  id: string;
  songId: string;
}

export interface PlaylistState {
  name: string;
  comment: string;
  public: boolean;
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
  base: PlaylistState | null;
  local: PlaylistState | null;
  revision: number;
}

export interface RemotePlaylist {
  id: string;
  name: string;
  comment: string;
  public: boolean;
  readonly: boolean;
  songIds: string[];
  owner?: string;
  created?: string;
  changed?: string;
  duration?: number;
  coverArt?: string;
  allowedUser?: string[];
  validUntil?: string;
}

export type RemotePlaylistMutation =
  | { type: "create"; localId: string; state: PlaylistState }
  | { type: "replace"; localId: string; serverId: string; previousSongCount: number; state: PlaylistState }
  | { type: "delete"; localId: string; serverId: string };
