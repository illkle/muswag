// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Album } from "@muswag/model";

vi.mock("@tanstack/react-router", () => ({ useElementScrollRestoration: () => undefined, useNavigate: () => () => {} }));
vi.mock("#/components/utils/app-content-size", () => ({ useContentSize: () => ({ width: 800, height: 600, ready: true }) }));

const { AlbumList } = await import("#/components/album-list/album-list");
type AlbumRows = import("#/library/album-rows").AlbumRows;

beforeAll(() => {
  // jsdom reports zero-sized elements, so the virtualizer would render no rows.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
});
afterEach(cleanup);

const album = (index: number) => ({ id: `al${index}`, name: `Album ${index}`, year: 2000 + index, artist: "Someone", artistId: "ar", coverArt: null }) as unknown as Album;

describe("AlbumList of rows it loads as they are shown", () => {
  it("draws the albums that have loaded, stands in for the rest, and says which it draws", () => {
    const shown: Array<[number, number]> = [];
    const rows: AlbumRows = { count: 34_000, at: (position) => (position < 3 ? album(position) : undefined), show: (start, end) => void shown.push([start, end]) };
    render(<AlbumList rows={rows} scrollId="test" />);

    expect(screen.getByText("Album 0")).toBeTruthy();
    expect(screen.getByText("Album 2")).toBeTruthy();
    expect(screen.queryByText("Album 3")).toBeNull();
    // Four columns fit in 800 pixels, so the rows drawn cover whole rows of albums from the first.
    const [start, end] = shown.at(-1)!;
    expect(start).toBe(0);
    expect(end % 4).toBe(0);
    expect(end).toBeGreaterThan(3);
  });
});
