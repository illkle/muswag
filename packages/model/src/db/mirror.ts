import type { Song } from "./schema.js";

/**
 * Song columns that stay in main: how to stream the file and the details no page shows. The renderers'
 * mirror leaves them out, which takes most of the weight off a song, and the library holds a lot of
 * them. A page that comes to show one of these takes it off the list. The play stats stay mirrored,
 * since refreshing them is what `LibrarySync.refreshStats` is for.
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

/** The columns the renderers' mirror leaves out, by table: `SqliteMirror`'s `omitColumns`. */
export const MIRROR_OMITTED_COLUMNS = { songs: MAIN_ONLY_SONG_COLUMNS };
