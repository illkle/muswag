import { albums, artists, MAIN_ONLY_SONG_COLUMNS, playlists, queueItems, queueState, songs } from "@muswag/model";
import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

/** Main owns the library database and the queue; these collections mirror their tables. Changes go through main's commands. */
export const mirrorClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer }) });

// Loading a table again means another snapshot from main, so a collection is kept once it has loaded.
const options = { client: mirrorClient, defaultIndexType: BasicIndex, readOnly: true, gcTime: 0 } as const;

export const db = {
  albums: createCollection(mirrorCollectionOptions({ ...options, table: albums })),
  artists: createCollection(mirrorCollectionOptions({ ...options, table: artists })),
  /**
   * Without the columns only main reads (`LibrarySong`). The largest table by far, so it loads when
   * something first reads it, a page or the search, rather than with the window.
   */
  songs: createCollection(mirrorCollectionOptions({ ...options, table: songs, omit: MAIN_ONLY_SONG_COLUMNS, startSync: false })),
  playlists: createCollection(mirrorCollectionOptions({ ...options, table: playlists })),
  /** The playback queue; read it through the hooks in `queue/queue.ts`. */
  queueItems: createCollection(mirrorCollectionOptions({ ...options, table: queueItems })),
  queueState: createCollection(mirrorCollectionOptions({ ...options, table: queueState })),
};

export type LibraryCollections = typeof db;

// Without an index a lookup scans its table, and a page makes one for every row it shows: the album of
// each track in a list. An index keeps a set of keys for each value, so a song is looked up by its key
// with `get` instead, rather than with an index on `id` costing a set for every song.
db.albums.createIndex(({ id }) => id);
db.albums.createIndex(({ artistId }) => artistId);
db.songs.createIndex(({ albumId }) => albumId);
db.playlists.createIndex(({ id }) => id);
