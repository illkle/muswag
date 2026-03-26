import { createCollection, type Collection } from "@tanstack/db";
import { createNodeSQLitePersistence, persistedCollectionOptions } from "@tanstack/node-db-sqlite-persistence";

import type { Album, Song, SyncRecord, UserCredentials } from "./types.js";

export type BetterSqlite3Database = {
  pragma(source: string): unknown;
  close(): void;
};

export interface MuswagDb {
  albums: Collection<Album, string>;
  songs: Collection<Song, string>;
  userCredentials: Collection<UserCredentials, number>;
  syncs: Collection<SyncRecord, string>;
}

export function createMuswagDb(database: BetterSqlite3Database): MuswagDb {
  const persistence = createNodeSQLitePersistence({ database: database as never }) as never;

  const albums = createCollection(
    persistedCollectionOptions<Album, string>({
      id: "albums",
      getKey: (album) => album.id,
      persistence,
      schemaVersion: 1,
    }),
  );

  const songs = createCollection(
    persistedCollectionOptions<Song, string>({
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
