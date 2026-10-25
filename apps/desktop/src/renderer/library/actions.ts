import type { AlbumPageRequest, LibrarySort, QueueSourceRef, RefreshTarget, SongPageRequest, SongRange, SyncMode } from "@muswag/model";

import { appCommand } from "#/data/app-command";

/** Library sync and page refreshes, both of which main runs. Sync status is in `appState.librarySync`. */
export const LibraryActions = {
  sync: (mode: SyncMode) => appCommand("library:sync", mode),
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
  /** A page of the albums page, newest first, which main reads from SQLite, with how many albums there are when `withTotal`. */
  albumPage: (request: AlbumPageRequest, withTotal: boolean) => appCommand("library:albumPage", request, withTotal),
  /** The artists with an album of their own, which are those the artists page lists, by name. */
  artistsWithAlbums: () => appCommand("library:artistsWithAlbums"),
  /** The cover art ids of the albums in `ids` that the library has, for the covers of their songs. */
  albumCoverArts: (ids: ReadonlyArray<string>) => appCommand("library:albumCoverArts", ids),
  /** The songs of the albums `ids`, album after album, each album's as its page lists them. */
  albumSongIds: (ids: ReadonlyArray<string>) => appCommand("library:albumSongIds", ids),
  /** An album and its songs, in the order it plays in. */
  album: (id: string) => appCommand("library:album", id),
  /** An artist's row and its own albums, newest first. */
  artist: (id: string) => appCommand("library:artist", id),
  /** An artist's albums and their songs, in the order the artist plays in. */
  discography: (id: string) => appCommand("library:discography", id),
  /** The albums of `ids` the library has, newest first. */
  albumsByIds: (ids: ReadonlyArray<string>) => appCommand("library:albumsByIds", ids),
  /** What the album, artist or playlist a queue plays from is called. */
  sourceName: (ref: QueueSourceRef) => appCommand("library:sourceName", ref),
};
