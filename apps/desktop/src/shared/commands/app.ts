import {
  AlbumPageRequest,
  AlbumSort,
  CreatePlaylistInput,
  Id,
  Ids,
  LibrarySort,
  QueueSourceRef,
  RefreshTarget,
  SongPageRequest,
  SongRanges,
  LoginCredentials,
  Text,
  type AlbumDetail,
  type AlbumPage,
  type ArtistAppearances,
  type ArtistDetail,
  type ArtistIndex,
  type Discography,
  type LibraryAlbum,
  type PlaylistDetail,
  type AuthSnapshot,
  type PlaylistEntry,
  type PlaylistRecord,
  type PlaylistRow,
  type PlaylistSyncStatus,
  type SearchResult,
  type SongPage,
} from "@muswag/model";
import { Schema } from "effect";

import { UpdateChannel } from "../state/app-update";
import { SyncSettings } from "../state/sync-settings";
import { Theme } from "../theme";
import { RendererCommand, type CommandResult } from "./player";

/**
 * The contract between the renderer and main, which owns the library, the session and the queue.
 * The renderer reads the library through the commands below, and main's state, the queue among it,
 * as main publishes it (`state/app-state.ts`); it changes anything only through these commands.
 */

// ---- Commands ----

/** Argument schemas; main decodes every command against them before running it. */
export const AppCommandArgs = {
  "session:login": Schema.Tuple([LoginCredentials]),
  "session:logout": Schema.Tuple([]),
  "library:sync": Schema.Tuple([]),
  "library:lastScan": Schema.Tuple([]),
  "library:setSyncSettings": Schema.Tuple([SyncSettings]),
  "library:refresh": Schema.Tuple([RefreshTarget]),
  "library:artistAppearances": Schema.Tuple([Id]),
  "library:search": Schema.Tuple([Text, Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 }))]),
  "library:songPage": Schema.Tuple([LibrarySort, SongPageRequest, Schema.Boolean]),
  "library:songIds": Schema.Tuple([LibrarySort, SongRanges]),
  "library:songPosition": Schema.Tuple([LibrarySort, Text]),
  "library:albumPage": Schema.Tuple([AlbumSort, AlbumPageRequest, Schema.Boolean]),
  "library:artistIndex": Schema.Tuple([]),
  "library:albumCoverArts": Schema.Tuple([Ids]),
  "library:albumSongIds": Schema.Tuple([Ids]),
  "library:album": Schema.Tuple([Id]),
  "library:artist": Schema.Tuple([Id]),
  "library:discography": Schema.Tuple([Id]),
  "library:albumsByIds": Schema.Tuple([Ids]),
  "library:sourceName": Schema.Tuple([QueueSourceRef]),
  "playlists:list": Schema.Tuple([]),
  "playlists:get": Schema.Tuple([Id]),
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
  "queue:shuffleSource": Schema.Tuple([QueueSourceRef]),
  "queue:setShuffle": Schema.Tuple([Schema.Boolean]),
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
  "window:setTheme": Schema.Tuple([Theme]),
} as const;

export type AppCommandResults = {
  "session:login": AuthSnapshot;
  "session:logout": AuthSnapshot;
  /**
   * Syncs the library, or waits for the sync running. It reads every song again unless the server says
   * it has not scanned its files since the last sync that did.
   */
  "library:sync": void;
  /** When the server says it last scanned its files, asked now; `null` when it does not say. */
  "library:lastScan": string | null;
  /** Keeps the settings of when the app syncs on its own, and goes by them from the next check on. */
  "library:setSyncSettings": void;
  "library:refresh": void;
  /** Read when asked: it is as current as the library was then. */
  "library:artistAppearances": ArtistAppearances;
  /** The best matches for a query, best first; `null` when a later search took its place before it ran. */
  "library:search": SearchResult[] | null;
  /** A page of the songs list in an order, with how many songs there are when the last argument asks. */
  "library:songPage": SongPage;
  /** The ids of the songs at the given positions of the songs list, in list order. */
  "library:songIds": string[];
  /** Where in the songs list the first song is whose title, artist or album, as the order goes by, starts at or after the text. */
  "library:songPosition": number;
  /** A page of the albums page in an order, with how many albums there are when the last argument asks. */
  "library:albumPage": AlbumPage;
  /** The artists the artists page lists, by name: those with an album of their own, and those only credited on others'. */
  "library:artistIndex": ArtistIndex;
  /** The cover art ids of the given albums, leaving out those the library does not have, in no particular order. */
  "library:albumCoverArts": Array<{ id: string; coverArt: string | null }>;
  /** The songs of the given albums, album after album in the order given, each album's in the order its page lists them. */
  "library:albumSongIds": string[];
  /** An album and its songs, in the order it plays in. */
  "library:album": AlbumDetail;
  /** An artist's row and its own albums, newest first. */
  "library:artist": ArtistDetail;
  /** An artist's albums and their songs, then its songs on others' albums, in the order the artist plays in. */
  "library:discography": Discography;
  /** The given albums that the library has, newest first. */
  "library:albumsByIds": LibraryAlbum[];
  /** What the album, artist or playlist a queue plays from is called; `null` for the library or one it does not have. */
  "library:sourceName": string | null;
  /** Every playlist, those awaiting deletion on the server among them. */
  "playlists:list": PlaylistRow[];
  /** A playlist as stored, `null` when there is none, and the songs of its entries that the library has. */
  "playlists:get": PlaylistDetail;
  "playlists:create": PlaylistRecord;
  "playlists:rename": void;
  "playlists:setComment": void;
  "playlists:setVisibility": void;
  "playlists:addEntries": PlaylistEntry[];
  "playlists:removeEntries": void;
  "playlists:moveEntries": void;
  "playlists:delete": void;
  "playlists:sync": PlaylistSyncStatus;
  "queue:playSource": void;
  "queue:shuffleSource": void;
  "queue:setShuffle": void;
  "queue:select": void;
  "queue:play": void;
  "queue:enqueue": void;
  "queue:moveQueued": void;
  "queue:removeQueued": void;
  "queue:next": void;
  "queue:previous": void;
  /**
   * How the player took the command. A command it turns down is not a failed app command: its outcome
   * is in the player's state, which renderers wait for at the version it gives either way.
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
  /** Draws what the OS draws of the windows, such as their controls on Windows, in the theme the user picked. */
  "window:setTheme": void;
};

export type AppCommandName = keyof typeof AppCommandArgs;
export type AppCommandArgs<K extends AppCommandName> = (typeof AppCommandArgs)[K]["Encoded"];

/** Failures cross IPC as data, so the renderer sees the message without Electron's wrapping. */
export type AppCommandReply<K extends AppCommandName> =
  | { readonly ok: true; readonly value: AppCommandResults[K] }
  | { readonly ok: false; readonly error: { readonly tag: string; readonly message: string } };
