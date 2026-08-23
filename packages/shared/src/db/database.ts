import { BasicIndex, type Collection } from "@tanstack/db";
import { persistedCollectionOptions, type PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import type { SyncRecord, SyncState, UserCredentials } from "./types.js";
import { createCollection } from "@tanstack/react-db";
import type { AlbumID3, Child, IndexArtist } from "@muswag/subsonic-api/schema";
import type { PlaylistRecord } from "../playlists/types.js";
import type { PlayerQueueRecord } from "../player-queue.js";
import { Context } from "effect";

export type BetterSqlite3Database = {
  pragma(source: string): unknown;
  close(): void;
};

export type Album = AlbumID3;
export type Artist = IndexArtist;
export type Song = Child;

export type CoverOnDisk = {
  key: string;
  fileName: string;
};

export interface MuswagDb {
  albums: Collection<Album, string>;
  artists: Collection<Artist, string>;
  songs: Collection<Child, string>;
  playlists: Collection<PlaylistRecord, string>;
  playerQueue: Collection<PlayerQueueRecord, number>;
  userCredentials: Collection<UserCredentials, number>;
  syncs: Collection<SyncRecord, string>;
  syncState: Collection<SyncState, number>;
  covers: Collection<CoverOnDisk, string>;
}

export class MuswagDatabase extends Context.Service<MuswagDatabase, MuswagDb>()("@muswag/subsonic-api/SubsonicCrypto") {}

export function createMuswagDb(persistence: PersistedCollectionPersistence): MuswagDb {
  const albums = createCollection(
    persistedCollectionOptions<Album, string>({
      id: "albums",
      getKey: (album) => album.id,
      persistence,
      schemaVersion: 1,
      defaultIndexType: BasicIndex,
    }),
  );

  albums.createIndex(({ id }) => id);

  const artists = createCollection(
    persistedCollectionOptions<Artist, string>({
      id: "artists",
      getKey: (artist) => artist.id,
      persistence,
      schemaVersion: 1,
      defaultIndexType: BasicIndex,
    }),
  );

  artists.createIndex(({ id }) => id);

  const songs = createCollection(
    persistedCollectionOptions<Child, string>({
      id: "songs",
      getKey: (song) => song.id,
      persistence,
      schemaVersion: 1,
      defaultIndexType: BasicIndex,
    }),
  );

  songs.createIndex(({ id }) => id);
  songs.createIndex(({ albumId }) => albumId);

  const playlists = createCollection(
    persistedCollectionOptions<PlaylistRecord, string>({
      id: "playlists",
      getKey: (playlist) => playlist.id,
      persistence,
      schemaVersion: 1,
      defaultIndexType: BasicIndex,
    }),
  );

  playlists.createIndex(({ id }) => id);
  playlists.createIndex(({ serverId }) => serverId);

  const userCredentials = createCollection(
    persistedCollectionOptions<UserCredentials, number>({
      id: "userCredentials",
      getKey: (cred) => cred.id,
      persistence,
      schemaVersion: 2,
    }),
  );

  const playerQueue = createCollection(
    persistedCollectionOptions<PlayerQueueRecord, number>({
      id: "playerQueue",
      getKey: (record) => record.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const syncs = createCollection(
    persistedCollectionOptions<SyncRecord, string>({
      id: "syncs",
      getKey: (sync) => sync.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const syncState = createCollection(
    persistedCollectionOptions<SyncState, number>({
      id: "syncState",
      getKey: (state) => state.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const covers = createCollection(
    persistedCollectionOptions<CoverOnDisk, string>({
      id: "syncState",
      getKey: (state) => state.key,
      persistence,
      schemaVersion: 1,
    }),
  );

  return {
    albums,
    artists,
    songs,
    playlists,
    playerQueue,
    userCredentials,
    syncs,
    syncState,
    covers,
  };
}
