import { Schema } from "effect";

/**
 * What main, which owns the library, and the renderer exchange. Each type is derived from its schema,
 * so main can decode what renderers send against the same definitions.
 */

/** An identifier: a library id, an entry id or an occurrence key. */
export const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
/** Free text a user typed, such as a playlist name. */
export const Text = Schema.String.check(Schema.isMaxLength(65_536));
export const Ids = Schema.Array(Id).check(Schema.isMaxLength(100_000));

export const SessionCredentials = Schema.Struct({ url: Text, username: Text, password: Text });
export type SessionCredentials = typeof SessionCredentials.Type;

export const AuthSnapshot = Schema.Union([
  Schema.TaggedStruct("Initializing", {}),
  Schema.TaggedStruct("LoggedOut", {}),
  Schema.TaggedStruct("LoggedIn", { url: Schema.String, username: Schema.String }),
]);
export type AuthSnapshot = typeof AuthSnapshot.Type;

export const SyncMode = Schema.Literals(["full", "quick"]);
export type SyncMode = typeof SyncMode.Type;

export const LibrarySyncStatus = Schema.Struct({
  /** The mode of the sync that is running, or `null` when idle. */
  running: Schema.NullOr(SyncMode),
  error: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
});
export type LibrarySyncStatus = typeof LibrarySyncStatus.Type;
export const IDLE_LIBRARY_SYNC: LibrarySyncStatus = { running: null, error: null, lastSyncedAt: null };

export const PlaylistSyncStatus = Schema.Struct({
  state: Schema.Literals(["idle", "scheduled", "syncing", "paused", "error"]),
  error: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
});
export type PlaylistSyncStatus = typeof PlaylistSyncStatus.Type;
export const IDLE_PLAYLIST_SYNC: PlaylistSyncStatus = { state: "idle", error: null, lastSyncedAt: null };

export const RefreshStatTarget = Schema.Struct({ type: Schema.Literals(["album", "playlist"]), id: Id });
export type RefreshStatTarget = typeof RefreshStatTarget.Type;

export const CoverTarget = Schema.Struct({ type: Schema.Literals(["album", "artist"]), id: Id, coverArtId: Schema.NullOr(Id) });
export type CoverTarget = typeof CoverTarget.Type;

export const CreatePlaylistInput = Schema.Struct({ name: Text, comment: Schema.optional(Text), public: Schema.optional(Schema.Boolean), songIds: Schema.optional(Ids) });
export type CreatePlaylistInput = typeof CreatePlaylistInput.Type;
