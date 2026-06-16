import type {
  GetAlbumDetailResult,
  GetAlbumsResult,
  GetSongByIdResult,
  GetSongsInput,
  GetSongsResult,
  SyncRecord,
  UserCredentialsToLogin,
  UserInfo,
} from '@muswag/shared';

import type { PlayQueueInput, PlayerEvent, PlayerState } from './player';

export type MuswagMainIpc = {
  'db:getAlbumDetail': (albumId: string) => GetAlbumDetailResult;
  'db:getAlbums': () => GetAlbumsResult;
  'db:getSongById': (songId: string) => GetSongByIdResult;
  'db:getSongs': (input?: GetSongsInput) => GetSongsResult;
  'player:getState': () => PlayerState;
  'player:next': () => void;
  'player:pause': () => void;
  'player:play': () => void;
  'player:playQueue': (input: PlayQueueInput) => void;
  'player:previous': () => void;
  'player:seek': (positionSeconds: number) => void;
  'player:toggle': () => void;
  'sync:login': (credentials: UserCredentialsToLogin) => Promise<UserInfo>;
  'sync:logout': () => Promise<null>;
  'sync:run': () => Promise<SyncRecord>;
};

export type MuswagRendererIpc = {
  'db:reloadAll': [];
  'player:event': [event: PlayerEvent];
};
