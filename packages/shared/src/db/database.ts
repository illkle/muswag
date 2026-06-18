import { type Collection } from "@tanstack/db";
import { persistedCollectionOptions, type PersistedCollectionPersistence } from "@tanstack/db-sqlite-persistence-core";

import type { SyncRecord, UserCredentials } from "./types.js";
import { createCollection } from "@tanstack/react-db";
import type { AlbumID3, Child } from "@muswag/subsonic-api";

export type BetterSqlite3Database = {
  pragma(source: string): unknown;
  close(): void;
};

export type Album = AlbumID3 & { coverArtPath: string | undefined };
export type Song = Child;

export interface MuswagDb {
  albums: Collection<Album, string>;
  songs: Collection<Child, string>;
  userCredentials: Collection<UserCredentials, number>;
  syncs: Collection<SyncRecord, string>;
}

export function createMuswagDb(persistence: PersistedCollectionPersistence): MuswagDb {
  const albums = createCollection(
    persistedCollectionOptions<Album, string>({
      id: "albums",
      getKey: (album) => album.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const songs = createCollection(
    persistedCollectionOptions<Child, string>({
      id: "songs",
      getKey: (song) => song.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const userCredentials = createCollection(
    persistedCollectionOptions<UserCredentials, number>({
      id: "userCredentials",
      getKey: (cred) => cred.id,
      persistence,
      schemaVersion: 2,
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

  return { albums, songs, userCredentials, syncs };
}
