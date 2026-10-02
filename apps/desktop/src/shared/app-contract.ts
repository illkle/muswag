import type { AuthSnapshot, LibrarySyncStatus, PlaylistEntry, PlaylistRecord, PlaylistSyncStatus } from "@muswag/shared";
import type { MirrorPosition } from "@muswag/tanstack-db-sqlite-mirror/protocol";
import { Schema } from "effect";

import { emptyQueueState, type QueueManagerState } from "./queue-state";

/**
 * The contract between the renderer and main, which owns the library, the session and the queue.
 * The renderer reads library data from mirrored collections; everything else goes through commands
 * and the states below.
 */

// ---- States main publishes ----

export type AppStates = {
  auth: AuthSnapshot;
  librarySync: LibrarySyncStatus;
  playlistSync: PlaylistSyncStatus;
  queue: QueueManagerState;
};
export type AppStateName = keyof AppStates;

export const initialAppStates = (): AppStates => ({
  auth: { _tag: "Initializing" },
  librarySync: { running: null, error: null, lastSyncedAt: null },
  playlistSync: { state: "idle", error: null, lastSyncedAt: null },
  queue: emptyQueueState(),
});

// ---- Commands ----

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Text = Schema.String.check(Schema.isMaxLength(65_536));
const Ids = Schema.Array(Id).check(Schema.isMaxLength(100_000));
const CoverTarget = Schema.Struct({ type: Schema.Literals(["album", "artist"]), id: Id, coverArtId: Schema.NullOr(Id) });
const QueueSourceRef = Schema.Union([Schema.Struct({ type: Schema.Literal("playlist"), playlistId: Id }), Schema.Struct({ type: Schema.Literal("album"), albumId: Id })]);

/** Argument schemas; main decodes every command against them before running it. */
export const AppCommandArgs = {
  "session:login": Schema.Tuple([Schema.Struct({ url: Text, username: Text, password: Text })]),
  "session:logout": Schema.Tuple([]),
  "library:sync": Schema.Tuple([Schema.Literals(["full", "quick"])]),
  "library:cancelSync": Schema.Tuple([]),
  "library:refreshStats": Schema.Tuple([Schema.Struct({ type: Schema.Literals(["album", "playlist"]), id: Id })]),
  "covers:ensure": Schema.Tuple([CoverTarget]),
  "covers:repair": Schema.Tuple([CoverTarget, Text]),
  "playlists:create": Schema.Tuple([Schema.Struct({ name: Text, comment: Schema.optional(Text), public: Schema.optional(Schema.Boolean), songIds: Schema.optional(Ids) })]),
  "playlists:rename": Schema.Tuple([Id, Text]),
  "playlists:setComment": Schema.Tuple([Id, Text]),
  "playlists:setVisibility": Schema.Tuple([Id, Schema.Boolean]),
  "playlists:addEntries": Schema.Tuple([Id, Ids, Schema.NullOr(Id)]),
  "playlists:removeEntry": Schema.Tuple([Id, Id]),
  "playlists:moveEntry": Schema.Tuple([Id, Id, Schema.NullOr(Id)]),
  "playlists:delete": Schema.Tuple([Id]),
  "playlists:sync": Schema.Tuple([]),
  "queue:playSource": Schema.Tuple([QueueSourceRef, Id]),
  "queue:enqueue": Schema.Tuple([Ids]),
  "queue:removeQueued": Schema.Tuple([Id]),
  "queue:clearQueued": Schema.Tuple([]),
  "queue:next": Schema.Tuple([]),
  "queue:previous": Schema.Tuple([]),
} as const;

/** A library write that renderers can wait for with `collection.utils.awaitPosition`. */
export type Written<T = void> = { readonly value: T; readonly position: MirrorPosition };

export type AppCommandResults = {
  "session:login": AuthSnapshot;
  "session:logout": AuthSnapshot;
  "library:sync": void;
  "library:cancelSync": void;
  "library:refreshStats": void;
  "covers:ensure": string | null;
  "covers:repair": string | null;
  "playlists:create": Written<PlaylistRecord>;
  "playlists:rename": Written;
  "playlists:setComment": Written;
  "playlists:setVisibility": Written;
  "playlists:addEntries": Written<PlaylistEntry[]>;
  "playlists:removeEntry": Written;
  "playlists:moveEntry": Written;
  "playlists:delete": Written;
  "playlists:sync": PlaylistSyncStatus;
  "queue:playSource": void;
  "queue:enqueue": void;
  "queue:removeQueued": void;
  "queue:clearQueued": void;
  "queue:next": void;
  "queue:previous": void;
};

export type AppCommandName = keyof typeof AppCommandArgs;
export type AppCommandArgs<K extends AppCommandName> = (typeof AppCommandArgs)[K]["Encoded"];

/** Failures cross IPC as data, so the renderer sees the message without Electron's wrapping. */
export type AppCommandReply<K extends AppCommandName> =
  | { readonly ok: true; readonly value: AppCommandResults[K] }
  | { readonly ok: false; readonly error: { readonly tag: string; readonly message: string } };
