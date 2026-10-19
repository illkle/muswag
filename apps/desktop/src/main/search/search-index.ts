import type { SearchHit } from "@muswag/model";
import Fuse from "fuse.js";

// With its extension: the worker imports this module, and in tests Node loads it without a bundler.
import { KEYS, SEARCHED_COLUMNS, TYPES, type SearchedChange, type SearchedLibrary, type SearchedRow } from "./searched-fields.ts";

type Entry = { readonly type: SearchHit["type"]; readonly id: string } & { readonly [type in SearchHit["type"]]?: SearchedRow };

/** How long the library has to stay unchanged before the index is built again ahead of a search. */
const QUIET_MS = 1_000;

/**
 * Fuzzy search over the albums, artists and songs of the library, which `read` gives whole.
 *
 * The index does not follow the library row by row. A change to a field a search looks at only marks
 * it stale, and it is built again from what `read` gives then: a fraction of a second for a large
 * library, where keeping up with a sync or a logout one row at a time took far longer than that. It is
 * built once the library has been quiet for a moment, and otherwise by the next search.
 */
export function createSearchIndex(read: () => SearchedLibrary) {
  const fuse = new Fuse<Entry>([], { keys: [...KEYS], shouldSort: true, ignoreLocation: true, findAllMatches: true, threshold: 0.2 });
  /** What the index was built from, by `type:id`, to tell whether a change finds anything new. */
  let entries = new Map<string, Entry>();
  let stale = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const build = () => {
    clearTimeout(timer);
    stale = false;
    const library = read();
    entries = new Map(
      (Object.keys(TYPES) as Array<keyof SearchedLibrary>).flatMap((table) => {
        const type = TYPES[table];
        return library[table].map((row) => [`${type}:${row.id}`, { type, id: row.id, [type]: row }] as const);
      }),
    );
    fuse.setCollection([...entries.values()]);
  };

  /** Whether `change` adds or takes away a row, or changes a field a search looks at. A search answers with the rows as they are now, so any other change finds nothing new. */
  const searched = (change: SearchedChange) => {
    const table = change.table as keyof SearchedLibrary;
    const type = TYPES[table];
    if (!type) return false;
    if (change.type === "delete") return entries.has(`${type}:${change.key}`);
    const before = entries.get(`${type}:${change.value.id}`)?.[type];
    return !before || SEARCHED_COLUMNS[table].some((column) => before[column] !== change.value[column]);
  };

  return {
    /** Marks the index stale for what `changes` change, and builds it again once the library has stopped changing. */
    changed(changes: ReadonlyArray<SearchedChange>) {
      if (!changes.some(searched)) return;
      stale = true;
      clearTimeout(timer);
      timer = setTimeout(build, QUIET_MS);
    },

    /** Builds the index now, unless it is up to date: ahead of the first search, say. */
    prepare() {
      if (stale) build();
    },

    /** The best matches for `query`, best first. */
    search(query: string, limit: number): SearchHit[] {
      if (stale) build();
      return fuse.search(query, { limit }).map(({ item }) => ({ type: item.type, id: item.id }));
    },

    dispose() {
      clearTimeout(timer);
    },
  };
}
