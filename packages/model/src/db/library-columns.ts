import type { Album, Artist, Song } from "./schema.js";

/**
 * Song columns that stay in main: how to stream the file and the details no page shows. What main
 * reads for renderers leaves them out, which takes most of the weight off a song, and a change to them
 * alone is not announced. A page that comes to show one of these takes it off the list. The play stats
 * stay in, for the pages that `LibrarySync.refresh` reads again when they open, and so do the keys the
 * library is sorted by, which no page shows: a corrected key moves the song in the songs list.
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

/** A song as renderers get it, without `MAIN_ONLY_SONG_COLUMNS`. Every `Song` is one. */
export type LibrarySong = Omit<Song, (typeof MAIN_ONLY_SONG_COLUMNS)[number]>;

/**
 * Album columns that stay in main: where its cover was downloaded to, which main writes as each cover
 * arrives. Announced, every download would be a change that has open pages read their albums again.
 */
export const MAIN_ONLY_ALBUM_COLUMNS = ["coverArtPath"] as const satisfies ReadonlyArray<keyof Album>;

/** An album as renderers get it, without `MAIN_ONLY_ALBUM_COLUMNS`. Every `Album` is one. */
export type LibraryAlbum = Omit<Album, (typeof MAIN_ONLY_ALBUM_COLUMNS)[number]>;

/** Artist columns that stay in main: where its image was downloaded to, as for albums. */
export const MAIN_ONLY_ARTIST_COLUMNS = ["coverArtPath"] as const satisfies ReadonlyArray<keyof Artist>;

/** An artist as renderers get it, without `MAIN_ONLY_ARTIST_COLUMNS`. Every `Artist` is one. */
export type LibraryArtist = Omit<Artist, (typeof MAIN_ONLY_ARTIST_COLUMNS)[number]>;

/** Columns whose changes alone are not announced, by table: those renderers never get. */
export const UNANNOUNCED_COLUMNS = { songs: MAIN_ONLY_SONG_COLUMNS, albums: MAIN_ONLY_ALBUM_COLUMNS, artists: MAIN_ONLY_ARTIST_COLUMNS };
