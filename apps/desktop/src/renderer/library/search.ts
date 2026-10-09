import type { Album, Artist, Song } from "@muswag/model";
import type { Collection } from "@tanstack/react-db";
import Fuse from "fuse.js";

/** Something a search found: the row itself. What the row does not hold, such as the cover of a song's album, is read where the result is shown. */
export type SearchResult = { type: "song"; id: string; song: Song } | { type: "album"; id: string; album: Album } | { type: "artist"; id: string; artist: Artist };

type Rows<Row extends object> = Pick<Collection<Row, string, any>, "subscribeChanges" | "toArray">;

/**
 * Fuzzy search over the albums, artists and songs of the library.
 *
 * The index does not follow the collections row by row. A change only marks it stale, and the next
 * search builds it again from what the collections hold then: a fraction of a second for a large
 * library, where keeping up with a sync or a logout one row at a time took far longer than that.
 */
export function createSearchIndex(library: { albums: Rows<Album>; artists: Rows<Artist>; songs: Rows<Song> }) {
  const fuse = new Fuse<SearchResult>([], {
    keys: ["song.artist", "song.album", "song.title", "song.year", "album.artist", { name: "album.name", weight: 3 }, "album.year", { name: "artist.name", weight: 2 }],
    shouldSort: true,
    ignoreLocation: true,
    findAllMatches: true,
    threshold: 0.2,
  });

  let stale = true;
  const markStale = () => {
    stale = true;
  };
  library.albums.subscribeChanges(markStale);
  library.artists.subscribeChanges(markStale);
  library.songs.subscribeChanges(markStale);

  return {
    /** The best matches for `query`, best first. */
    search(query: string, limit: number): SearchResult[] {
      if (stale) {
        stale = false;
        fuse.setCollection([
          ...library.albums.toArray.map((album): SearchResult => ({ type: "album", id: album.id, album })),
          ...library.artists.toArray.map((artist): SearchResult => ({ type: "artist", id: artist.id, artist })),
          ...library.songs.toArray.map((song): SearchResult => ({ type: "song", id: song.id, song })),
        ]);
      }

      return fuse.search(query, { limit }).map(({ item }) => item);
    },
  };
}
