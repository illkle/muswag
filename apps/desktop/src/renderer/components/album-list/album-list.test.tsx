// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Album } from "@muswag/model";

const { navigate, albumSongIds, startSongDrag } = vi.hoisted(() => ({ navigate: vi.fn(), albumSongIds: vi.fn(), startSongDrag: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useElementScrollRestoration: () => undefined, useNavigate: () => navigate }));
vi.mock("#/library/actions", () => ({ LibraryActions: { albumSongIds } }));
vi.mock("#/lib/song-drag", () => ({ startSongDrag }));
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

describe("AlbumList selection", () => {
  it("leaves albums that have left a fully loaded grid out of the drag", async () => {
    const { rerender } = render(<AlbumList albums={[0, 1, 2].map(album)} scrollId="test" />);
    const tile = (index: number) => screen.getByText(`Album ${index}`).closest("button")!;
    fireEvent.click(tile(0), { metaKey: true });
    fireEvent.click(tile(2), { metaKey: true });
    rerender(<AlbumList albums={[1, 2].map(album)} scrollId="test" />);

    fireEvent.dragStart(tile(2));
    const drag = startSongDrag.mock.calls.at(-1)![1];
    expect(drag.label).toBe("Album 2");
    await drag.songIds();
    expect(albumSongIds).toHaveBeenLastCalledWith(["al2"]);
  });

  it("selects with Cmd or Ctrl and Shift, opens an album on a plain click, and drags the selection in grid order", async () => {
    render(<AlbumList albums={[0, 1, 2, 3, 4].map(album)} scrollId="test" />);
    const tile = (index: number) => screen.getByText(`Album ${index}`).closest("button")!;
    const selected = () => [...document.querySelectorAll("[aria-pressed=true]")].map((element) => (element as HTMLElement).dataset.albumId);

    fireEvent.click(tile(3), { metaKey: true });
    fireEvent.click(tile(1), { shiftKey: true });
    expect(selected()).toEqual(["al1", "al2", "al3"]);
    fireEvent.click(tile(2), { ctrlKey: true });
    expect(selected()).toEqual(["al1", "al3"]);
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.dragStart(tile(3));
    const [, drag] = startSongDrag.mock.calls.at(-1)!;
    expect(drag.label).toBe("2 albums");
    await drag.songIds();
    expect(albumSongIds).toHaveBeenCalledWith(["al1", "al3"]);

    // A tile outside the selection is dragged alone, and selected.
    fireEvent.dragStart(tile(4));
    expect(startSongDrag.mock.calls.at(-1)![1].label).toBe("Album 4");
    expect(selected()).toEqual(["al4"]);

    fireEvent.keyDown(tile(4), { key: "Escape" });
    expect(selected()).toEqual([]);
    expect(screen.queryByText(/selected$/)).toBeNull();

    // The pill above the player says how many are selected, and lets go of them.
    fireEvent.click(tile(0), { metaKey: true });
    fireEvent.click(tile(1), { metaKey: true });
    screen.getByText("2 albums selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(selected()).toEqual([]);
    expect(screen.queryByText(/selected$/)).toBeNull();
    fireEvent.click(tile(0));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ params: { albumId: "al0" } }));
  });
});
