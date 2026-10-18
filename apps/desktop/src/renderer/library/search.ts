import type { Album, Artist, LibrarySong } from "@muswag/model";
import type { ChangeMessage, Collection } from "@tanstack/react-db";
import Fuse from "fuse.js";

/** Something a search found: the row itself. What the row does not hold, such as the cover of a song's album, is read where the result is shown. */
export type SearchResult = { type: "song"; id: string; song: LibrarySong } | { type: "album"; id: string; album: Album } | { type: "artist"; id: string; artist: Artist };

type Rows<Row extends object> = Pick<Collection<Row, string, any>, "subscribeChanges" | "toArray" | "get">;

const KEYS = ["song.artist", "song.album", "song.title", "song.year", "album.artist", { name: "album.name", weight: 3 }, "album.year", { name: "artist.name", weight: 2 }] as const;

/** The fields of a row of `type` that a search looks at. */
const searchedFields = (type: SearchResult["type"]) =>
  KEYS.flatMap((key) => {
    const [owner, field] = (typeof key === "string" ? key : key.name).split(".");
    return owner === type && field ? [field] : [];
  });

/** How long the library has to stay unchanged before the index is built again ahead of a search. */
const QUIET_MS = 1_000;

/**
 * Fuzzy search over the albums, artists and songs of the library.
 *
 * The index does not follow the collections row by row. A change to a field a search looks at only
 * marks it stale, and it is built again from what the collections hold then: a fraction of a second
 * for a large library, where keeping up with a sync or a logout one row at a time took far longer than
 * that. It is built once the library has been quiet for a moment and the window is idle, so that
 * typing does not wait for it, and otherwise by the next search.
 *
 * Nothing is read until `prepare` or the first search: the songs only load for a collection that is
 * read, and the search is what most often reads them all.
 */
export function createSearchIndex(library: { albums: Rows<Album>; artists: Rows<Artist>; songs: Rows<LibrarySong> }) {
  const fuse = new Fuse<SearchResult>([], { keys: [...KEYS], shouldSort: true, ignoreLocation: true, findAllMatches: true, threshold: 0.2 });

  let prepared = false;
  let stale = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts the builds made ahead of a search, so that a search shown already can be run again on what they found. */
  let builds = 0;
  const listeners = new Set<() => void>();

  const build = () => {
    stale = false;
    fuse.setCollection([
      ...library.albums.toArray.map((album): SearchResult => ({ type: "album", id: album.id, album })),
      ...library.artists.toArray.map((artist): SearchResult => ({ type: "artist", id: artist.id, artist })),
      ...library.songs.toArray.map((song): SearchResult => ({ type: "song", id: song.id, song })),
    ]);
  };

  // Without `requestIdleCallback` the next search builds it.
  const buildWhenIdle = () => {
    if (typeof requestIdleCallback !== "function") return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      requestIdleCallback(() => {
        if (!stale) return;
        build();
        builds++;
        for (const listener of listeners) listener();
      });
    }, QUIET_MS);
  };

  /**
   * Marks the index stale when a row comes or goes, or a field a search looks at changes. A change to
   * any other field finds nothing new, and a search answers with the rows as they are now.
   */
  const follow = <Row extends object>(rows: Rows<Row>, type: SearchResult["type"]) => {
    const fields = searchedFields(type) as Array<keyof Row>;
    const searched = (change: ChangeMessage<Row>) => change.type !== "update" || change.previousValue === undefined || fields.some((field) => change.value[field] !== change.previousValue?.[field]);
    // Leaving out the rows already there: an update to one of them would otherwise come as its insert.
    rows.subscribeChanges(
      (changes) => {
        if (!changes.some(searched)) return;
        stale = true;
        buildWhenIdle();
      },
      { includeInitialState: false },
    );
  };

  /** `result` with its row as the collection holds it now. */
  const current = (result: SearchResult): SearchResult => {
    switch (result.type) {
      case "song":
        return { ...result, song: library.songs.get(result.id) ?? result.song };
      case "album":
        return { ...result, album: library.albums.get(result.id) ?? result.album };
      case "artist":
        return { ...result, artist: library.artists.get(result.id) ?? result.artist };
    }
  };

  const prepare = () => {
    if (prepared) return;
    prepared = true;
    follow(library.albums, "album");
    follow(library.artists, "artist");
    follow(library.songs, "song");
    buildWhenIdle();
  };

  return {
    /**
     * Starts loading what the search reads and builds the index once it has, ahead of the first search.
     * Call it when a search is about to start, such as when the field gets the focus.
     */
    prepare,

    /**
     * Follows the builds made ahead of a search, such as the one once the songs have loaded: a search
     * answered before then left them out, and is to be run again. Returns the number of builds so far.
     */
    builds: () => builds,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The best matches for `query`, best first. */
    search(query: string, limit: number): SearchResult[] {
      prepare();
      if (stale) build();
      return fuse.search(query, { limit }).map(({ item }) => current(item));
    },
  };
}
