import type {
  GetAlbumDetailResult,
  GetAlbumsResult,
  GetSongByIdResult,
  GetSongsInput,
  GetSongsResult,
  login,
  logout,
  sync,
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
  'sync:login': typeof login;
  'sync:logout': typeof logout;
  'sync:run': typeof sync;
};

export type MuswagRendererIpc = {
  'player:event': [event: PlayerEvent];
};
