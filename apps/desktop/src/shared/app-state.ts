import { AuthSnapshot, LibrarySyncStatus, PlaylistSyncStatus } from "@muswag/model";
import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

/**
 * Main's session and sync status as renderers see them: one-row memory tables in the state mirror.
 * Each row is `{ id, value }`, keyed by the table's own name.
 */

export const auth = memoryTable("auth", Schema.Struct({ id: Schema.Literal("auth"), value: AuthSnapshot }), { primaryKey: "id" });

export const librarySync = memoryTable("library_sync", Schema.Struct({ id: Schema.Literal("library_sync"), value: LibrarySyncStatus }), { primaryKey: "id" });

export const playlistSync = memoryTable("playlist_sync", Schema.Struct({ id: Schema.Literal("playlist_sync"), value: PlaylistSyncStatus }), { primaryKey: "id" });

export const APP_TABLES = [auth, librarySync, playlistSync] as const;
