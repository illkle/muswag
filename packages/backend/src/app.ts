import { Layer } from "effect";

import type { ReadCoverColours } from "./covers/cover-manager.js";
import { DatabaseLive } from "./db/database.js";
import { PlaylistCommands, PlaylistEdits } from "./playlists/commands.js";
import { CredentialsStoreSql } from "./session/credentials-store.js";
import { SessionManagerLive } from "./session/session-manager.js";

export interface BackendLiveOptions {
  /** SQLite database file. */
  readonly filename: string;
  /** Directory for cover files, relative to `MiniFs`. */
  readonly coverSaveLocation: string;
  /** How albums' colours are read from their cover files. */
  readonly readCoverColours: ReadCoverColours;
}

/**
 * Everything main runs on top of the library database: the session with its sync services, playlist
 * commands, and the mirror server that renderers connect to. Needs `MiniFs`, `Path`, `HttpClient`
 * and `Crypto` from the platform.
 */
export const BackendLive = (options: BackendLiveOptions) =>
  Layer.mergeAll(SessionManagerLive({ coverSaveLocation: options.coverSaveLocation, readCoverColours: options.readCoverColours }), PlaylistCommands.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(CredentialsStoreSql(), PlaylistEdits.layer)),
    Layer.provideMerge(DatabaseLive(options.filename)),
  );
