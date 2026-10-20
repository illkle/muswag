import type { Album, Song } from "./schema.js";

/**
 * Song columns that stay in main: how to stream the file and the details no page shows. The renderers'
 * mirror leaves them out, which takes most of the weight off a song, and the library holds a lot of
 * them. A page that comes to show one of these takes it off the list. The play stats stay mirrored,
 * for the pages that `LibrarySync.refresh` reads again when they open, and so do the keys the library
 * is sorted by, which no page shows: a change to a column left out is not sent, and a corrected key
 * moves the song in the songs list.
 */
export const MAIN_ONLY_SONG_COLUMNS = [
  "isDir",
  "bitRate",
  "bookmarkPosition",
  "contentType",
  "coverArt",
  "created",
  "genre",
  "isVideo",
  "originalHeight",
  "originalWidth",
  "parent",
  "path",
  "size",
  "suffix",
  "transcodedContentType",
  "transcodedSuffix",
  "type",
  "bpm",
  "comment",
  "sortName",
  "musicBrainzId",
  "genres",
  "albumArtists",
  "displayAlbumArtist",
  "contributors",
  "displayComposer",
  "moods",
  "replayGain",
  "explicitStatus",
] as const satisfies ReadonlyArray<keyof Song>;

/** A song as renderers mirror it, without `MAIN_ONLY_SONG_COLUMNS`. Every `Song` is one. */
export type LibrarySong = Omit<Song, (typeof MAIN_ONLY_SONG_COLUMNS)[number]>;

/**
 * Album columns that stay in main: where its cover was downloaded to, which main writes as each cover
 * arrives. Mirrored, every download would be a change that has open pages read their albums again.
 */
export const MAIN_ONLY_ALBUM_COLUMNS = ["coverArtPath"] as const satisfies ReadonlyArray<keyof Album>;

/** An album as renderers mirror it, without `MAIN_ONLY_ALBUM_COLUMNS`. Every `Album` is one. */
export type LibraryAlbum = Omit<Album, (typeof MAIN_ONLY_ALBUM_COLUMNS)[number]>;

/** The columns the renderers' mirror leaves out, by table: `SqliteMirror`'s `omitColumns`. */
export const MIRROR_OMITTED_COLUMNS = { songs: MAIN_ONLY_SONG_COLUMNS, albums: MAIN_ONLY_ALBUM_COLUMNS };
