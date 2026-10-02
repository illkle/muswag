import { CoverTarget, CreatePlaylistInput, Id, Ids, QueueSourceRef, RefreshStatTarget, SessionCredentials, SyncMode, Text, type AuthSnapshot, type PlaylistEntry, type PlaylistRecord, type PlaylistSyncStatus } from "@muswag/model";
import type { MirrorPosition } from "@muswag/tanstack-db-mirror/protocol";
import { Schema } from "effect";

/**
 * The contract between the renderer and main, which owns the library, the session and the queue.
 * The renderer reads library data and the queue from mirrored collections, and main's in-memory state
 * from the state mirror (`state-mirror.ts`); it changes anything only through the commands below.
 */

// ---- Commands ----

/** Argument schemas; main decodes every command against them before running it. */
export const AppCommandArgs = {
  "session:login": Schema.Tuple([SessionCredentials]),
  "session:logout": Schema.Tuple([]),
  "library:sync": Schema.Tuple([SyncMode]),
  "library:cancelSync": Schema.Tuple([]),
  "library:refreshStats": Schema.Tuple([RefreshStatTarget]),
  "covers:ensure": Schema.Tuple([CoverTarget]),
  "covers:repair": Schema.Tuple([CoverTarget, Text]),
  "playlists:create": Schema.Tuple([CreatePlaylistInput]),
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
