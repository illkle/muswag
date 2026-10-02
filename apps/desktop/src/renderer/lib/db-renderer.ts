import { albums, artists, playlists, songs } from "@muswag/model";
import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-sqlite-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-sqlite-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

import { CreateFuse } from "./search";

/** Main owns the library database; these collections mirror its tables. Changes go through main's commands. */
export const mirrorClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer }) });

const options = { client: mirrorClient, defaultIndexType: BasicIndex, readOnly: true } as const;

export const db = {
  albums: createCollection(mirrorCollectionOptions({ ...options, table: albums })),
  artists: createCollection(mirrorCollectionOptions({ ...options, table: artists })),
  songs: createCollection(mirrorCollectionOptions({ ...options, table: songs })),
  playlists: createCollection(mirrorCollectionOptions({ ...options, table: playlists })),
};

export type LibraryCollections = typeof db;

db.songs.createIndex(({ albumId }) => albumId);

export const FuzeSearch = CreateFuse(db);
