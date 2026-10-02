import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

/**
 * Main's session and sync status as renderers see them: one-row memory tables in the state mirror.
 * Each row is `{ id, value }`, keyed by the table's own name.
 */

const Timestamp = Schema.NullOr(Schema.String);

export const AuthSnapshot = Schema.Union([
  Schema.TaggedStruct("Initializing", {}),
  Schema.TaggedStruct("LoggedOut", {}),
  Schema.TaggedStruct("LoggedIn", { url: Schema.String, username: Schema.String }),
]);
export const auth = memoryTable("auth", Schema.Struct({ id: Schema.Literal("auth"), value: AuthSnapshot }), { primaryKey: "id" });

export const LibrarySyncStatus = Schema.Struct({ running: Schema.NullOr(Schema.Literals(["full", "quick"])), error: Schema.NullOr(Schema.String), lastSyncedAt: Timestamp });
export const librarySync = memoryTable("library_sync", Schema.Struct({ id: Schema.Literal("library_sync"), value: LibrarySyncStatus }), { primaryKey: "id" });

export const PlaylistSyncStatus = Schema.Struct({
  state: Schema.Literals(["idle", "scheduled", "syncing", "paused", "error"]),
  error: Schema.NullOr(Schema.String),
  lastSyncedAt: Timestamp,
});
export const playlistSync = memoryTable("playlist_sync", Schema.Struct({ id: Schema.Literal("playlist_sync"), value: PlaylistSyncStatus }), { primaryKey: "id" });

export const APP_TABLES = [auth, librarySync, playlistSync] as const;
