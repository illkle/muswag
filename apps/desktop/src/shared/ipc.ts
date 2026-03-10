import type {
  GetAlbumDetailResult,
  GetAlbumsResult,
  GetSongsInput,
  GetSongsResult,
  SyncAlbumsResult,
  SyncCredentials,
  SyncManagerEvent,
  SyncUserState,
} from "@muswag/db";

export type MuswagMainIpc = {
  "db:getAlbumDetail": (albumId: string) => GetAlbumDetailResult;
  "db:getAlbums": () => GetAlbumsResult;
  "db:getSongs": (input?: GetSongsInput) => GetSongsResult;
  "sync:getUserState": () => SyncUserState;
  "sync:login": (credentials: SyncCredentials) => SyncUserState;
  "sync:logout": () => SyncUserState;
  "sync:run": () => SyncAlbumsResult;
};

export type MuswagRendererIpc = {
  "sync:event": [event: SyncManagerEvent];
};
