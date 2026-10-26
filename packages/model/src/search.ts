import type { LibrarySong } from "./db/library-columns.js";
import type { Album, Artist } from "./db/schema.js";

/** A row a search found, by its table: albums, artists, songs and playlists are searched together. */
export type SearchHit = { readonly type: "song" | "album" | "artist" | "playlist"; readonly id: string };

/** A playlist a search found: what its result shows of it. */
export type PlaylistSearchResult = {
  readonly id: string;
  readonly name: string;
  readonly songCount: number;
  readonly owner: string | null;
  /** The first four albums it draws on, for its artwork. */
  readonly albumIds: ReadonlyArray<string>;
};

/** A hit with its row as the library held it at the time of the search. What the row does not hold, such as the cover of a song's album, is read where the result is shown. */
export type SearchResult =
  | { type: "song"; id: string; song: LibrarySong }
  | { type: "album"; id: string; album: Album }
  | { type: "artist"; id: string; artist: Artist }
  | { type: "playlist"; id: string; playlist: PlaylistSearchResult };
