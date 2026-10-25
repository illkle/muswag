import { QueryClient, useQuery, type Query, type QueryKey } from "@tanstack/react-query";

import { onLibraryChange } from "./library-changes";

/** Main answers from the database on this machine: a read waits for no network, and one that fails says so at once. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { networkMode: "always", retry: false } } });

/** While the library keeps changing, as in a sync, reads of the tables it changes are made again at most this often. */
const REFRESH_MS = 250;
/** How long the library has to stay unchanged before a quiet read is made again. */
const QUIET_MS = 1_000;
/** How long changes that keep coming can put a quiet read off. */
const LONGEST_WAIT_MS = 5_000;

type ReadMeta = { readonly tables: ReadonlyArray<string>; readonly quiet: boolean };
const metaOf = (query: Query) => query.meta as ReadMeta | undefined;
const dependsOn = (query: Query, tables: ReadonlySet<string>) => metaOf(query)?.tables.some((table) => tables.has(table)) ?? false;

/**
 * Reads again the queries over any of `tables` that are in use, and marks the others to be read when
 * next used. Resolves once they have been read: a read another invalidation cancels hands on to the
 * read that one starts.
 */
export const invalidateTables = (tables: Iterable<string>, which: (meta: ReadMeta) => boolean = () => true): Promise<void> => {
  const changed = new Set(tables);
  return queryClient.invalidateQueries({ predicate: (query) => dependsOn(query, changed) && which(metaOf(query)!) });
};

/** Tables that changed since reads of them were last made again, gathered until the reads are due. */
class Pending {
  readonly tables = new Set<string>();
  timer: ReturnType<typeof setTimeout> | undefined;

  take(): string[] {
    const tables = [...this.tables];
    this.tables.clear();
    this.timer = undefined;
    return tables;
  }
}

let following = false;
const pending = new Pending();
const pendingQuiet = new Pending();
let lastRefresh = -Infinity;
let firstQuietChange: number | undefined;
/** How many changes each table has had, so that a read can tell whether one came while it ran. */
const changeCounts = new Map<string, number>();
const changesOf = (tables: ReadonlyArray<string>) => tables.reduce((sum, table) => sum + (changeCounts.get(table) ?? 0), 0);

/**
 * Reads again what changed in the library: at once after a quiet spell and then at most every
 * `REFRESH_MS`, or, for quiet reads, once the library has stayed unchanged for `QUIET_MS`.
 */
function follow(): void {
  following = true;
  onLibraryChange((event) => {
    const now = performance.now();
    for (const table of Object.keys(event.tables)) {
      pending.tables.add(table);
      pendingQuiet.tables.add(table);
      changeCounts.set(table, (changeCounts.get(table) ?? 0) + 1);
    }
    pending.timer ??= setTimeout(
      () => {
        lastRefresh = performance.now();
        void invalidateTables(pending.take(), ({ quiet }) => !quiet);
      },
      Math.max(0, lastRefresh + REFRESH_MS - now),
    );
    firstQuietChange ??= now;
    clearTimeout(pendingQuiet.timer);
    pendingQuiet.timer = setTimeout(
      () => {
        firstQuietChange = undefined;
        void invalidateTables(pendingQuiet.take(), ({ quiet }) => quiet);
      },
      Math.max(0, Math.min(QUIET_MS, firstQuietChange + LONGEST_WAIT_MS - now)),
    );
  });
}

export interface MainRead<T> {
  readonly queryKey: QueryKey;
  /** The library tables the read depends on: a change of any of them reads it again. */
  readonly tables: ReadonlyArray<string>;
  readonly read: () => Promise<T>;
  /**
   * Read again only once the library has stayed unchanged for a moment, rather than as it changes:
   * for reads that cost main more than they are worth during a sync, such as those of a whole discography.
   */
  readonly quiet?: boolean;
}

/**
 * `read` as the query `queryKey` runs it. A change to one of `tables` while it runs may have come after
 * main read the answer, and React Query does not read again a query that is still being read for the
 * first time, so the query is read again once this answer is in: at once, or for a quiet read after `QUIET_MS`.
 */
export const readFresh =
  <T>({ queryKey, tables, read, quiet = false }: MainRead<T>) =>
  async (): Promise<T> => {
    if (!following) follow();
    const before = changesOf(tables);
    const value = await read();
    if (changesOf(tables) !== before) setTimeout(() => void queryClient.invalidateQueries({ queryKey, exact: true }), quiet ? QUIET_MS : 0);
    return value;
  };

/** The options of `useQuery` for a read of main's: kept until a table it depends on changes. */
export const mainReadOptions = <T>(options: MainRead<T>) => {
  const meta: ReadMeta = { tables: options.tables, quiet: options.quiet ?? false };
  return { queryKey: options.queryKey, queryFn: readFresh(options), meta, staleTime: Infinity };
};

/**
 * What `read` reads from main's library, read again whenever one of `tables` changes; what was read
 * stays meanwhile. Rows that come back the same keep their identity, so what draws them is not drawn again.
 */
export function useMainRead<T>(options: MainRead<T>) {
  if (!following) follow();
  return useQuery(mainReadOptions(options));
}
