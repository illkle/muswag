import { db } from "#/lib/db-renderer";
import { createPlaylistSyncManager } from "@muswag/shared";

/**
 * Exactly one manager may exist per database. A second instance — another BrowserWindow, or a
 * copy in the main process — would race on the same rows and push duplicate playlists to the
 * server, so this module is the only place a manager is constructed. If the app ever opens more
 * than one window, this has to move into the main process behind IPC.
 */
export const PlaylistSync = createPlaylistSyncManager(db);

/**
 * The playlist controls read the collection synchronously and throw when it has not loaded, so
 * kick the read off as soon as the renderer boots.
 */
export const playlistsReady = db.playlists.preload();

window.addEventListener("beforeunload", () => {
  PlaylistSync.destroy();
});
