import { songRow, type LibrarySong, type SongPage, type SongPageRequest } from "@muswag/model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAGE_SIZE, PagedWindow, type PagedWindowSource } from "#/library/paged-window";

type SongWindowSource = PagedWindowSource<LibrarySong>;

/** A library of `count` songs in order, answering page requests the way main does, one at a time, when told to. */
function fakeLibrary(count: number) {
  let songs: LibrarySong[] = Array.from({ length: count }, (_, index) => songRow({ id: `s${index}`, title: `Song ${index}` }));
  const requests: Array<{ request: SongPageRequest; withTotal: boolean; answer: () => void }> = [];
  const listeners = new Set<() => void>();

  const read = (request: SongPageRequest, withTotal: boolean): SongPage => {
    const total = withTotal ? songs.length : null;
    if ("offset" in request) return { songs: songs.slice(request.offset, request.offset + request.limit), total };
    const at = songs.findIndex(({ id }) => id === ("after" in request ? request.after : request.before));
    if (at === -1) return null;
    return { songs: "after" in request ? songs.slice(at + 1, at + 1 + request.limit) : songs.slice(Math.max(0, at - request.limit), at), total };
  };

  const source: SongWindowSource = {
    page: (request, withTotal) =>
      new Promise((resolve) => {
        requests.push({
          request,
          withTotal,
          answer: () => {
            const page = read(request, withTotal);
            resolve(page && { rows: page.songs, total: page.total });
          },
        });
      }),
    byNeighbour: true,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    source,
    requests,
    /** Answers the request waiting, and lets the window go on to the next. */
    answer: async () => {
      const next = requests.shift();
      if (!next) throw new Error("No request is waiting");
      next.answer();
      await vi.advanceTimersByTimeAsync(0);
      return next;
    },
    /** Answers requests until none is left. */
    settle: async () => {
      while (requests.length > 0) {
        requests.shift()!.answer();
        await vi.advanceTimersByTimeAsync(0);
      }
    },
    change: (next: (songs: LibrarySong[]) => LibrarySong[]) => {
      songs = next(songs);
      for (const listener of listeners) listener();
    },
  };
}

const idsAt = (window: PagedWindow<LibrarySong>, start: number, end: number) => Array.from({ length: end - start }, (_, index) => window.at(start + index)?.id);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PagedWindow", () => {
  it("reads the first page with the count, then the pages around what is shown", async () => {
    const library = fakeLibrary(1_000);
    const window = new PagedWindow(library.source);

    expect(library.requests[0]).toMatchObject({ request: { offset: 0, limit: PAGE_SIZE }, withTotal: true });
    await library.answer();
    expect(window.total).toBe(1_000);
    expect(window.at(0)?.id).toBe("s0");

    window.show(0, 30);
    await library.settle();
    // The page after the first is asked for as the songs after its last one.
    expect(window.at(150)?.id).toBe("s150");
    expect(window.at(250)).toBeUndefined();
  });

  it("asks for a page next to one it holds by that page's end, and for any other by its offset", async () => {
    const library = fakeLibrary(1_000);
    const window = new PagedWindow(library.source);
    await library.settle();

    window.show(500, 530);
    const jump = await library.answer();
    expect(jump.request).toEqual({ offset: 500, limit: PAGE_SIZE });
    const next = await library.answer();
    expect(next.request).toEqual({ before: "s500", limit: PAGE_SIZE });
    const after = await library.answer();
    expect(after.request).toEqual({ after: "s599", limit: PAGE_SIZE });
    expect(idsAt(window, 398, 402)).toEqual([undefined, undefined, "s400", "s401"]);
    expect(idsAt(window, 499, 501)).toEqual(["s499", "s500"]);
    expect(idsAt(window, 598, 602)).toEqual(["s598", "s599", "s600", "s601"]);
  });

  it("reads one page at a time, and only for where the list is when it can ask again", async () => {
    const library = fakeLibrary(10_000);
    const window = new PagedWindow(library.source);
    await library.settle();

    // A drag of the scrollbar through the list while the first page after it is read.
    window.show(2_000, 2_030);
    for (let position = 2_000; position <= 9_000; position += 500) window.show(position, position + 30);
    expect(library.requests).toHaveLength(1);
    await library.answer();
    expect(library.requests[0]!.request).toEqual({ offset: 9_000, limit: PAGE_SIZE });
  });

  it("keeps showing pages that are out of date until those in view have been read again", async () => {
    const library = fakeLibrary(300);
    const window = new PagedWindow(library.source);
    await library.answer();
    window.show(0, 30);
    await library.settle();

    library.change((songs) => [songRow({ id: "new", title: "A new song" }), ...songs]);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.at(0)?.id).toBe("s0");
    expect(library.requests[0]).toMatchObject({ request: { offset: 0, limit: PAGE_SIZE }, withTotal: true });

    await library.settle();
    expect(window.total).toBe(301);
    expect(idsAt(window, 0, 3)).toEqual(["new", "s0", "s1"]);
  });

  it("reads again at most every quarter second while songs keep changing", async () => {
    const library = fakeLibrary(300);
    new PagedWindow(library.source);
    await library.settle();

    let reads = 0;
    for (let tick = 0; tick < 20; tick++) {
      library.change((songs) => songs);
      await vi.advanceTimersByTimeAsync(50);
      reads += library.requests.length;
      await library.settle();
    }
    // A second's worth of changes every 50 ms, read again no more than five times, each the page in view with the count.
    expect(reads).toBeLessThanOrEqual(5 * 2);
    expect(reads).toBeGreaterThan(0);
  });

  it("asks by offset when the song a page was to be read around has gone", async () => {
    const library = fakeLibrary(300);
    const window = new PagedWindow(library.source);
    await library.answer();
    window.show(0, 30);
    library.change((songs) => songs.filter(({ id }) => id !== "s99"));
    await library.settle();
    await vi.advanceTimersByTimeAsync(300);
    await library.settle();

    expect(window.total).toBe(299);
    expect(idsAt(window, 98, 101)).toEqual(["s98", "s100", "s101"]);
  });

  it("waits before asking again after a page could not be read", async () => {
    const page = vi.fn<SongWindowSource["page"]>().mockRejectedValue(new Error("main is gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    new PagedWindow({ page, byNeighbour: true, subscribe: () => () => {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(page).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("stops reading and listening once disposed", async () => {
    const library = fakeLibrary(300);
    const window = new PagedWindow(library.source);
    window.dispose();
    await library.settle();
    library.change((songs) => songs);
    await vi.advanceTimersByTimeAsync(500);
    expect(library.requests).toHaveLength(0);
    expect(window.total).toBeUndefined();
  });
});

describe("PagedWindow without neighbours", () => {
  it("asks for every page by its offset", async () => {
    const library = fakeLibrary(1_000);
    const window = new PagedWindow({ ...library.source, byNeighbour: false });
    await library.settle();
    window.show(150, 180);
    const asked: unknown[] = [];
    while (library.requests.length > 0) asked.push((await library.answer()).request);
    expect(asked.every((request) => typeof request === "object" && request !== null && "offset" in request)).toBe(true);
    expect(window.at(250)?.id).toBe("s250");
  });
});
