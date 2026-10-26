import type { AlbumPageRequest, AlbumSort, LibrarySort, QueueSourceRef, RefreshTarget, SongPageRequest, SongRange } from "@muswag/model";

import { appCommand } from "#/data/app-command";
import type { SyncSettings } from "#shared/state/sync-settings";

/** Library sync and page refreshes, both of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: () => appCommand("library:sync"),
  /** When the server says it last scanned its files, which main asks it now; `null` when it does not say. */
  lastScan: () => appCommand("library:lastScan"),
  setSyncSettings: (settings: SyncSettings) => appCommand("library:setSyncSettings", settings),
  refresh: (target: RefreshTarget) => appCommand("library:refresh", target),
  /** Where an artist appears on other artists' albums, which main finds in the credits of every song. */
  artistAppearances: (artistId: string) => appCommand("library:artistAppearances", artistId),
  /** The best matches for `query` among the albums, artists and songs, which main searches; `null` when a later search took its place. */
  search: (query: string, limit: number) => appCommand("library:search", query, limit),
  /** A page of the songs list in `sort` order, which main reads from SQLite, with how many songs there are when `withTotal`; `null` for a page around a song that has gone. */
  songPage: (sort: LibrarySort, request: SongPageRequest, withTotal: boolean) => appCommand("library:songPage", sort, request, withTotal),
  /** The ids of the songs at `ranges` of the songs list in `sort` order, in list order. */
  songIds: (sort: LibrarySort, ranges: ReadonlyArray<SongRange>) => appCommand("library:songIds", sort, ranges),
  /** Where the songs whose title, artist or album, as `sort` goes by, starts at or after `text` begin in the songs list. */
  songPosition: (sort: LibrarySort, text: string) => appCommand("library:songPosition", sort, text),
  /** A page of the albums page in `sort` order, which main reads from SQLite, with how many albums there are when `withTotal`. */
  albumPage: (sort: AlbumSort, request: AlbumPageRequest, withTotal: boolean) => appCommand("library:albumPage", sort, request, withTotal),
  /** The artists the artists page lists, by name: those with an album of their own, and those only credited on others' albums. */
  artistIndex: () => appCommand("library:artistIndex"),
  /** The cover art ids of the albums in `ids` that the library has, for the covers of their songs. */
  albumCoverArts: (ids: ReadonlyArray<string>) => appCommand("library:albumCoverArts", ids),
  /** The songs of the albums `ids`, album after album, each album's as its page lists them. */
  albumSongIds: (ids: ReadonlyArray<string>) => appCommand("library:albumSongIds", ids),
  /** An album and its songs, in the order it plays in. */
  album: (id: string) => appCommand("library:album", id),
  /** An artist's row and its own albums, newest first. */
  artist: (id: string) => appCommand("library:artist", id),
  /** An artist's albums and their songs, then its songs on others' albums, in the order the artist plays in. */
  discography: (id: string) => appCommand("library:discography", id),
  /** The albums of `ids` the library has, newest first. */
  albumsByIds: (ids: ReadonlyArray<string>) => appCommand("library:albumsByIds", ids),
  /** What the album, artist or playlist a queue plays from is called. */
  sourceName: (ref: QueueSourceRef) => appCommand("library:sourceName", ref),
};
