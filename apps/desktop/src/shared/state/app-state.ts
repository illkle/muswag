import type { AuthSnapshot, LibrarySyncStatus, PlaylistSyncStatus } from "@muswag/model";

import type { QueueManagerState } from "#shared/queue-state";
import type { AppUpdateState } from "./app-update";
import type { PlayerPositionRow, PlayerRow } from "./player";
import type { UnplayableTrack } from "./queue";
import type { SyncSettings } from "./sync-settings";

/**
 * Main's state as renderers see it, a value of each kind, which main publishes whole whenever it
 * changes (`main/app-state.ts`). A renderer reads all of it when it connects, then hears of each
 * change. A value main has not published yet is missing.
 */
export type AppStateValues = {
  /** What the player is doing. */
  readonly player: PlayerRow;
  /** Where the player is in its track, apart from the rest: it changes twice a second. */
  readonly playerPosition: PlayerPositionRow;
  readonly auth: AuthSnapshot;
  readonly librarySync: LibrarySyncStatus;
  /** When the app syncs the library on its own. */
  readonly syncSettings: SyncSettings;
  readonly playlistSync: PlaylistSyncStatus;
  readonly appUpdate: AppUpdateState;
  /** The tracks the queue started and the player could not play, until they play or the queue is cleared. */
  readonly unplayable: ReadonlyArray<UnplayableTrack>;
  /** The playback queue, as main's queue manager holds it. */
  readonly queue: QueueManagerState;
};

export type AppStateName = keyof AppStateValues;

/**
 * Every published value and the version of the state they make up. The version goes up by one with
 * each change, so a renderer that has seen a version has seen every change up to it.
 */
export type AppStateSnapshot = { readonly version: number; readonly values: Partial<AppStateValues> };

/** One value that changed, and the version of the state it makes. */
export type AppStateUpdate = { [K in AppStateName]: { readonly version: number; readonly name: K; readonly value: AppStateValues[K] } }[AppStateName];

/**
 * Which library tables a write changed, with the keys of the rows it changed, or `null` where there were
 * too many to list: the renderer then takes every row of the table as changed.
 */
export type LibraryChangedEvent = { readonly tables: { readonly [table: string]: ReadonlyArray<string | number> | null } };
