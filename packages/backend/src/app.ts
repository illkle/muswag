import { Layer } from "effect";

import { DatabaseLive } from "./db/database.js";
import { PlaylistCommands, PlaylistEdits } from "./playlists/commands.js";
import { CredentialsStoreSql, type CredentialsCipher } from "./session/credentials-store.js";
import { SessionManagerLive } from "./session/session-manager.js";

export interface BackendLiveOptions {
  /** SQLite database file. */
  readonly filename: string;
  /** Directory for cover files, relative to `MiniFs`. */
  readonly coverSaveLocation: string;
  readonly cipher?: CredentialsCipher;
}

/**
 * Everything main runs on top of the library database: the session with its sync services, playlist
 * commands, and the mirror server that renderers connect to. Needs `MiniFs`, `Path`, `HttpClient`
 * and `Crypto` from the platform.
 */
export const BackendLive = (options: BackendLiveOptions) =>
  Layer.mergeAll(SessionManagerLive({ coverSaveLocation: options.coverSaveLocation }), PlaylistCommands.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(CredentialsStoreSql(options.cipher), PlaylistEdits.layer)),
    Layer.provideMerge(DatabaseLive(options.filename)),
  );
