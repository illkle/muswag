import type { SongPageRequest } from "@muswag/model";
import { replaceEqualDeep } from "@tanstack/react-query";

/** Rows in a page: a few screens of a list, which main reads in about a millisecond. */
export const PAGE_SIZE = 100;
/** Pages kept around those in view, so that scrolling back finds them. */
const KEPT_PAGES = 30;
/** While the rows keep changing, as in a sync, the pages in view are read again at most this often. */
const REFRESH_MS = 250;
/** After a page could not be read, how long the window waits before it asks again. */
const RETRY_MS = 2_000;

type Page<Row> = { readonly rows: readonly Row[]; readonly version: number };

/** What the window held at one moment, for a page to draw: a new one after every page read. */
export type PagedWindowView = {
  readonly total: number | undefined;
  /** The last page could not be read; the window asks again in a moment. */
  readonly failed: boolean;
};

/** How a page is asked for: by its offset, or as the rows right after or before a row, by its id. */
export type PageRequest = SongPageRequest;

export interface PagedWindowSource<Row> {
  /** A page of the list, with how many rows there are when `withTotal`; `null` for a page around a row that has gone. */
  readonly page: (request: PageRequest, withTotal: boolean) => Promise<{ readonly rows: readonly Row[]; readonly total: number | null } | null>;
  /** Whether `page` takes the rows after or before a row; without it every page is asked for by its offset. */
  readonly byNeighbour: boolean;
  /** Calls `listener` whenever the rows may have changed, and returns a function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * A list main holds, such as the songs or the albums of the library, as much of it as a page shows.
 * The page says which positions it draws (`show`), and the pages over them are read from main one at a
 * time, the one nearest the middle of the view first, so a drag of the scrollbar asks only for where it
 * is now rather than for every page it passed. Where the source can, a page next to one already read is
 * asked for as the rows after or before that page's end, which main finds through the order's index,
 * where an offset would make it count every row before.
 *
 * When the rows change, every page is out of date, along with how many rows there are. The pages stay
 * on screen until those in view have been read again, so the list never empties for it.
 */
export class PagedWindow<Row extends { readonly id: string }> {
  /** How many rows there are, once the first page has said. */
  total: number | undefined = undefined;
  /** What `useSyncExternalStore` compares: a new one with every change to what the window holds. */
  private snapshot: PagedWindowView = { total: undefined, failed: false };

  private readonly pages = new Map<number, Page<Row>>();
  /** Goes up with every change to the rows; a page read before it is out of date. */
  private version = 0;
  private totalVersion = -1;
  private shown = { start: 0, end: 0 };
  private reading = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRefresh = -Infinity;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(private readonly source: PagedWindowSource<Row>) {
    this.unsubscribe = source.subscribe(() => this.changed());
    this.read();
  }

  /** The row at `position`, from a page that has been read, if it is still there. */
  at(position: number): Row | undefined {
    return this.pages.get(Math.floor(position / PAGE_SIZE))?.rows[position % PAGE_SIZE];
  }

  /** The positions the list draws, from `start` up to `end`. */
  show(start: number, end: number): void {
    if (start === this.shown.start && end === this.shown.end) return;
    this.shown = { start, end };
    this.read();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): PagedWindowView => this.snapshot;

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.retryTimer);
    this.unsubscribe();
    this.listeners.clear();
  }

  /** Marks everything out of date, at most every `REFRESH_MS`, and reads again what is in view. */
  private changed(): void {
    if (this.refreshTimer !== undefined) return;
    const wait = Math.max(0, this.lastRefresh + REFRESH_MS - performance.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.lastRefresh = performance.now();
      this.version++;
      this.read();
    }, wait);
  }

  /** The pages over the view, and one on each side, the one nearest its middle first. */
  private wanted(): number[] {
    const first = Math.max(0, Math.floor(this.shown.start / PAGE_SIZE) - 1);
    const last = Math.floor(Math.max(this.shown.start, this.shown.end - 1) / PAGE_SIZE) + 1;
    const middle = (this.shown.start + this.shown.end) / 2 / PAGE_SIZE;
    const pages: number[] = [];
    for (let page = first; page <= last; page++) {
      if (this.total !== undefined && page * PAGE_SIZE >= this.total) break;
      pages.push(page);
    }
    return pages.sort((left, right) => Math.abs(left + 0.5 - middle) - Math.abs(right + 0.5 - middle));
  }

  /** How to ask for `page`: after or before a page next to it that is up to date, or else by its offset. */
  private requestFor(page: number): PageRequest {
    const offset = { offset: page * PAGE_SIZE, limit: PAGE_SIZE };
    if (!this.source.byNeighbour) return offset;
    const before = this.pages.get(page - 1);
    if (before?.version === this.version && before.rows.length === PAGE_SIZE) return { after: before.rows.at(-1)!.id, limit: PAGE_SIZE };
    const after = this.pages.get(page + 1);
    if (after?.version === this.version && after.rows.length > 0) return { before: after.rows[0]!.id, limit: PAGE_SIZE };
    return offset;
  }

  /** Reads the next page the view needs, one at a time, until it has them all. */
  private read(): void {
    if (this.reading || this.retryTimer !== undefined || this.disposed) return;
    const needsTotal = this.totalVersion !== this.version;
    const page = this.wanted().find((index) => this.pages.get(index)?.version !== this.version) ?? (needsTotal ? Math.floor(this.shown.start / PAGE_SIZE) : undefined);
    if (page === undefined) return;

    const version = this.version;
    const request = this.requestFor(page);
    this.reading = true;
    this.source
      .page(request, needsTotal)
      // A row the request was made around is gone: by offset then.
      .then((result) => result ?? ("offset" in request ? null : this.source.page({ offset: page * PAGE_SIZE, limit: PAGE_SIZE }, needsTotal)))
      .then(
        (result) => {
          if (this.disposed || !result) return;
          if (result.total !== null) {
            this.total = result.total;
            this.totalVersion = version;
            for (const index of this.pages.keys()) if (index * PAGE_SIZE >= result.total) this.pages.delete(index);
          }
          this.pages.set(page, { rows: this.reuse(page, result.rows), version });
          this.evict();
          this.publish(false);
        },
        (cause: unknown) => {
          console.error("[paged-window] a page of the list could not be read", cause);
          if (!this.snapshot.failed) this.publish(true);
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.read();
          }, RETRY_MS);
        },
      )
      .finally(() => {
        this.reading = false;
        this.read();
      });
  }

  /**
   * `rows` with each row that has not changed since the page was last read replaced by the object read
   * then, so that what draws it sees the same row and is not drawn again. A refresh mostly reads back
   * what was there.
   */
  private reuse(page: number, rows: readonly Row[]): readonly Row[] {
    const before = this.pages.get(page);
    if (!before) return rows;
    const byId = new Map(before.rows.map((row) => [row.id, row]));
    return rows.map((row) => {
      const previous = byId.get(row.id);
      return previous ? replaceEqualDeep(previous, row) : row;
    });
  }

  private publish(failed: boolean): void {
    this.snapshot = { total: this.total, failed };
    for (const listener of this.listeners) listener();
  }

  /** Lets go of the pages furthest from the view, beyond the ones kept. */
  private evict(): void {
    if (this.pages.size <= KEPT_PAGES) return;
    const middle = (this.shown.start + this.shown.end) / 2 / PAGE_SIZE;
    const furthest = [...this.pages.keys()].sort((left, right) => Math.abs(right - middle) - Math.abs(left - middle));
    for (const index of furthest.slice(0, this.pages.size - KEPT_PAGES)) this.pages.delete(index);
  }
}
