import {
  AlbumPageRequest,
  CreatePlaylistInput,
  Id,
  Ids,
  LibrarySort,
  QueueSourceRef,
  RefreshTarget,
  SongPageRequest,
  SongRanges,
  LoginCredentials,
  SyncMode,
  Text,
  type AlbumPage,
  type ArtistAppearances,
  type AuthSnapshot,
  type PlaylistEntry,
  type PlaylistRecord,
  type PlaylistSyncStatus,
  type SearchResult,
  type SongPage,
} from "@muswag/model";
import type { MirrorPosition } from "@muswag/tanstack-db-mirror/protocol";
import { Schema } from "effect";

import { UpdateChannel } from "../state/app-update";
import { RendererCommand, type CommandResult } from "./player";

/**
 * The contract between the renderer and main, which owns the library, the session and the queue.
 * The renderer reads library data and the queue from mirrored collections, and main's in-memory state
 * from the state mirror (`state/mirror.ts`); it changes anything only through the commands below.
 */

// ---- Commands ----

/** Argument schemas; main decodes every command against them before running it. */
export const AppCommandArgs = {
  "session:login": Schema.Tuple([LoginCredentials]),
  "session:logout": Schema.Tuple([]),
  "library:sync": Schema.Tuple([SyncMode]),
  "library:refresh": Schema.Tuple([RefreshTarget]),
  "library:artistAppearances": Schema.Tuple([Id]),
  "library:search": Schema.Tuple([Text, Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))]),
  "library:songPage": Schema.Tuple([LibrarySort, SongPageRequest, Schema.Boolean]),
  "library:songIds": Schema.Tuple([LibrarySort, SongRanges]),
  "library:songPosition": Schema.Tuple([LibrarySort, Text]),
  "library:albumPage": Schema.Tuple([AlbumPageRequest, Schema.Boolean]),
  "library:artistsWithAlbums": Schema.Tuple([]),
  "library:albumCoverArts": Schema.Tuple([Ids]),
  "library:albumSongIds": Schema.Tuple([Ids]),
  "playlists:create": Schema.Tuple([CreatePlaylistInput]),
  "playlists:rename": Schema.Tuple([Id, Text]),
  "playlists:setComment": Schema.Tuple([Id, Text]),
  "playlists:setVisibility": Schema.Tuple([Id, Schema.Boolean]),
  "playlists:addEntries": Schema.Tuple([Id, Ids, Schema.NullOr(Id)]),
  "playlists:removeEntries": Schema.Tuple([Id, Ids]),
  "playlists:moveEntries": Schema.Tuple([Id, Ids, Schema.NullOr(Id)]),
  "playlists:delete": Schema.Tuple([Id]),
  "playlists:sync": Schema.Tuple([]),
  "queue:playSource": Schema.Tuple([QueueSourceRef, Id]),
  "queue:select": Schema.Tuple([Id]),
  "queue:play": Schema.Tuple([]),
  "queue:enqueue": Schema.Tuple([Ids, Schema.NullOr(Id)]),
  "queue:moveQueued": Schema.Tuple([Ids, Schema.NullOr(Id)]),
  "queue:removeQueued": Schema.Tuple([Ids]),
  "queue:next": Schema.Tuple([]),
  "queue:previous": Schema.Tuple([]),
  "player:execute": Schema.Tuple([RendererCommand]),
  "player:locate": Schema.Tuple([]),
  "appUpdate:check": Schema.Tuple([]),
  "appUpdate:install": Schema.Tuple([]),
  "appUpdate:setChannel": Schema.Tuple([UpdateChannel]),
} as const;

/** A library write that renderers can wait for with `collection.utils.awaitPosition`. */
export type Written<T = void> = { readonly value: T; readonly position: MirrorPosition };

export type AppCommandResults = {
  "session:login": AuthSnapshot;
  "session:logout": AuthSnapshot;
  "library:sync": void;
  "library:refresh": void;
  /** Read when asked, not mirrored: it is as current as the library was then. */
  "library:artistAppearances": ArtistAppearances;
  /** The best matches for a query, best first; `null` when a later search took its place before it ran. */
  "library:search": SearchResult[] | null;
  /** A page of the songs list in an order, with how many songs there are when the last argument asks. */
  "library:songPage": SongPage;
  /** The ids of the songs at the given positions of the songs list, in list order. */
  "library:songIds": string[];
  /** Where in the songs list the first song is whose title, artist or album, as the order goes by, starts at or after the text. */
  "library:songPosition": number;
  /** A page of the albums page, newest first, with how many albums there are when the last argument asks. */
  "library:albumPage": AlbumPage;
  /** The ids of the artists with an album of their own, which the artists page lists. */
  "library:artistsWithAlbums": string[];
  /** The cover art ids of the given albums, leaving out those the library does not have, in no particular order. */
  "library:albumCoverArts": Array<{ id: string; coverArt: string | null }>;
  /** The songs of the given albums, album after album in the order given, each album's in the order its page lists them. */
  "library:albumSongIds": string[];
  "playlists:create": Written<PlaylistRecord>;
  "playlists:rename": Written;
  "playlists:setComment": Written;
  "playlists:setVisibility": Written;
  "playlists:addEntries": Written<PlaylistEntry[]>;
  "playlists:removeEntries": Written;
  "playlists:moveEntries": Written;
  "playlists:delete": Written;
  "playlists:sync": PlaylistSyncStatus;
  "queue:playSource": void;
  "queue:select": void;
  "queue:play": void;
  "queue:enqueue": void;
  "queue:moveQueued": void;
  "queue:removeQueued": void;
  "queue:next": void;
  "queue:previous": void;
  /**
   * How the player took the command. A command it turns down is not a failed app command: its outcome
   * is in the player's state, which renderers wait for at the position it gives either way.
   */
  "player:execute": CommandResult;
  /** Lets the user pick an mpv binary in a native dialog and uses it; `null` when they cancel. */
  "player:locate": CommandResult | null;
  /** Checks for an update now. The outcome arrives in the update state (`state/app-update.ts`). */
  "appUpdate:check": void;
  /** Quits and installs a downloaded update. Does nothing until the status is `ready`. */
  "appUpdate:install": void;
  /** Updates from another channel from now on, and checks it. */
  "appUpdate:setChannel": void;
};

export type AppCommandName = keyof typeof AppCommandArgs;
export type AppCommandArgs<K extends AppCommandName> = (typeof AppCommandArgs)[K]["Encoded"];

/** Failures cross IPC as data, so the renderer sees the message without Electron's wrapping. */
export type AppCommandReply<K extends AppCommandName> =
  | { readonly ok: true; readonly value: AppCommandResults[K] }
  | { readonly ok: false; readonly error: { readonly tag: string; readonly message: string } };
