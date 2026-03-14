import type {
  GetAlbumDetailResult,
  GetAlbumsResult,
  GetSongByIdResult,
  GetSongsInput,
  GetSongsResult,
  SyncAlbumsResult,
  SyncCredentials,
  SyncManagerEvent,
  SyncUserState,
} from "@muswag/shared";

import type { PlayQueueInput, PlayerEvent, PlayerState } from "./player";

export type MuswagMainIpc = {
  "db:getAlbumDetail": (albumId: string) => GetAlbumDetailResult;
  "db:getAlbums": () => GetAlbumsResult;
  "db:getSongById": (songId: string) => GetSongByIdResult;
  "db:getSongs": (input?: GetSongsInput) => GetSongsResult;
  "player:getState": () => PlayerState;
  "player:next": () => PlayerState;
  "player:pause": () => PlayerState;
  "player:play": () => PlayerState;
  "player:playQueue": (input: PlayQueueInput) => PlayerState;
  "player:previous": () => PlayerState;
  "player:seek": (positionSeconds: number) => PlayerState;
  "player:toggle": () => PlayerState;
  "sync:getUserState": () => SyncUserState;
  "sync:login": (credentials: SyncCredentials) => SyncUserState;
  "sync:logout": () => SyncUserState;
  "sync:run": () => SyncAlbumsResult;
};

export type MuswagRendererIpc = {
  "player:event": [event: PlayerEvent];
  "sync:event": [event: SyncManagerEvent];
};
