import { albums, artists, MAIN_ONLY_ALBUM_COLUMNS, MAIN_ONLY_SONG_COLUMNS, playlists, queueItems, queueState, songs } from "@muswag/model";
import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";
import { BasicIndex, createCollection } from "@tanstack/react-db";

/** Main owns the library database and the queue; these collections mirror their tables. Changes go through main's commands. */
export const mirrorClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer }) });

// Loading a table again means another snapshot from main, so a collection is kept once it has loaded.
const options = { client: mirrorClient, defaultIndexType: BasicIndex, readOnly: true, gcTime: 0 } as const;

export const db = {
  /**
   * Only the albums the pages that are open ask for, read from main as they ask and read again when
   * albums change, as the songs are. The albums page reads its own pages (`library/album-rows.ts`).
   */
  albums: createCollection(mirrorCollectionOptions({ ...options, table: albums, omit: MAIN_ONLY_ALBUM_COLUMNS, syncMode: "on-demand", autoIndex: "eager" })),
  artists: createCollection(mirrorCollectionOptions({ ...options, table: artists })),
  /**
   * Only the songs the pages that are open ask for: an album's, an artist's, a playlist's, read from main
   * as they ask and read again when songs change. The library is far too large to hold, and the songs
   * page reads its own pages (`library/song-rows.ts`). Without the columns only main reads (`LibrarySong`).
   * Its indexes are made by the queries, which make them compare as they do.
   */
  songs: createCollection(mirrorCollectionOptions({ ...options, table: songs, omit: MAIN_ONLY_SONG_COLUMNS, syncMode: "on-demand", autoIndex: "eager" })),
  playlists: createCollection(mirrorCollectionOptions({ ...options, table: playlists })),
  /** The playback queue; read it through the hooks in `queue/queue.ts`. */
  queueItems: createCollection(mirrorCollectionOptions({ ...options, table: queueItems })),
  queueState: createCollection(mirrorCollectionOptions({ ...options, table: queueState })),
};

export type LibraryCollections = typeof db;

// Without an index a lookup scans its table.
db.playlists.createIndex(({ id }) => id);
