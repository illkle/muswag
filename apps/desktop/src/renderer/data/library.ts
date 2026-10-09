import { albums, artists, playlists, queueItems, queueState, songs } from "@muswag/model";
import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

/** Main owns the library database and the queue; these collections mirror their tables. Changes go through main's commands. */
export const mirrorClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer }) });

const options = { client: mirrorClient, defaultIndexType: BasicIndex, readOnly: true } as const;

export const db = {
  albums: createCollection(mirrorCollectionOptions({ ...options, table: albums })),
  artists: createCollection(mirrorCollectionOptions({ ...options, table: artists })),
  songs: createCollection(mirrorCollectionOptions({ ...options, table: songs })),
  playlists: createCollection(mirrorCollectionOptions({ ...options, table: playlists })),
  /** The playback queue; read it through `useQueueManagerState`. */
  queueItems: createCollection(mirrorCollectionOptions({ ...options, table: queueItems })),
  queueState: createCollection(mirrorCollectionOptions({ ...options, table: queueState })),
};

export type LibraryCollections = typeof db;

// Without an index a lookup scans its table, and a page makes one for every row it shows: the album of
// each track in a list, the song of each playlist entry.
db.albums.createIndex(({ id }) => id);
db.songs.createIndex(({ id }) => id);
db.songs.createIndex(({ albumId }) => albumId);
db.playlists.createIndex(({ id }) => id);
