// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { songRow } from "@muswag/model";

vi.mock("@tanstack/react-router", () => ({
  useElementScrollRestoration: () => undefined,
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("#/data/library", () => ({ db: {} }));
vi.mock("#/player/hooks", () => ({ usePlayerStatus: () => "playing" }));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: undefined }),
  eq: () => undefined,
}));

vi.mock("#/library/actions", () => ({ LibraryActions: {} }));

const { TrackList } = await import("#/components/track-list/track-list");
const { albumColumns, compactColumns, libraryColumns } = await import("#/components/track-list/columns");
type TrackColumn = import("#/components/track-list/columns").TrackColumn;
type TrackListItem = import("#/components/track-list/types").TrackListItem;
type TrackSelection = import("#/components/track-list/types").TrackSelection;

beforeAll(() => {
  // jsdom reports zero-sized elements, so the virtualizer would render no rows.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;

  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
});

afterEach(() => {
  cleanup();
});

const columns: TrackColumn[] = [
  { id: "position", width: "40px", Cell: ({ position }) => <span data-testid="position">{position + 1}</span> },
  { id: "title", width: "1fr", Cell: ({ item }) => item.song.title },
];

const track = (key: string, songId: string, title: string, unavailable = false): TrackListItem => ({ type: "track", key, song: songRow({ id: songId, title }), unavailable });

/** A playlist holding the same track three times, which is legal and must stay independently addressable. */
const duplicates = [track("entry-1", "song-a", "Repeat"), track("entry-2", "song-a", "Repeat"), track("entry-3", "song-a", "Repeat")];

const row = (key: string) => document.querySelector<HTMLElement>(`[data-track-key="${key}"]`)!;
const selectedKeys = () => [...document.querySelectorAll<HTMLElement>("[data-selected]")].map((element) => element.dataset.trackKey);

/** Renders a list whose menu records the selection it was last given. */
function renderWithMenu(items: TrackListItem[]) {
  const seen: { selection: TrackSelection | null } = { selection: null };
  render(
    <TrackList
      items={items}
      columns={columns}
      menu={(selection) => {
        seen.selection = selection;
        return null;
      }}
    />,
  );
  return seen;
}

describe("TrackList", () => {
  it("selects only the clicked row when the same song repeats", () => {
    render(<TrackList items={duplicates} columns={columns} />);

    fireEvent.click(row("entry-2"));

    expect(selectedKeys()).toEqual(["entry-2"]);
  });

  it("extends the selection with modified clicks", () => {
    render(<TrackList items={[track("a", "a", "A"), track("b", "b", "B"), track("c", "c", "C"), track("d", "d", "D")]} columns={columns} />);

    fireEvent.click(row("a"));
    fireEvent.click(row("c"), { shiftKey: true });
    expect(selectedKeys()).toEqual(["a", "b", "c"]);

    fireEvent.click(row("b"), { metaKey: true });
    expect(selectedKeys()).toEqual(["a", "c"]);
  });

  it("clears the selection on a click outside the rows and on Escape", () => {
    const { container } = render(<TrackList items={duplicates} columns={columns} />);
    const list = container.firstElementChild as HTMLElement;

    fireEvent.click(row("entry-1"));
    fireEvent.click(list);
    expect(selectedKeys()).toEqual([]);

    fireEvent.click(row("entry-1"));
    fireEvent.keyDown(list, { key: "Escape" });
    expect(selectedKeys()).toEqual([]);
  });

  it("selects every track with Mod+A", () => {
    const { container } = render(<TrackList items={duplicates} columns={columns} />);

    fireEvent.keyDown(container.firstElementChild!, { key: "a", metaKey: true });

    expect(selectedKeys()).toEqual(["entry-1", "entry-2", "entry-3"]);
  });

  it("marks only the row whose key is playing", () => {
    render(<TrackList items={duplicates} columns={columns} playingKey="entry-3" />);

    expect([...document.querySelectorAll<HTMLElement>("[data-playing]")].map((element) => element.dataset.trackKey)).toEqual(["entry-3"]);
  });

  it("activates the double-clicked row, so callers can tell which duplicate it was", () => {
    const onActivate = vi.fn();
    render(<TrackList items={duplicates} columns={columns} onActivate={onActivate} />);

    fireEvent.doubleClick(row("entry-3"));

    expect(onActivate).toHaveBeenCalledWith(duplicates[2]);
  });

  it("activates the selected row on Enter", () => {
    const onActivate = vi.fn();
    const { container } = render(<TrackList items={duplicates} columns={columns} onActivate={onActivate} />);

    fireEvent.click(row("entry-2"));
    fireEvent.keyDown(container.firstElementChild!, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledWith(duplicates[1]);
  });

  it("numbers tracks without counting the headings between them", () => {
    render(
      <TrackList
        items={[{ type: "heading", key: "disc:1", title: "Disc 1" }, track("a", "a", "A"), { type: "heading", key: "disc:2", title: "Disc 2", subtitle: "Live" }, track("b", "b", "B")]}
        columns={columns}
      />,
    );

    expect(screen.getAllByTestId("position").map((element) => element.textContent)).toEqual(["1", "2"]);
    expect(screen.getByText("Disc 2")).toBeTruthy();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("gives the menu the selection, and a right-click keeps a selection the row is part of", () => {
    const seen = renderWithMenu(duplicates);

    fireEvent.click(row("entry-1"));
    fireEvent.click(row("entry-3"), { metaKey: true });
    fireEvent.contextMenu(row("entry-3"));

    expect(seen.selection?.items.map(({ key }) => key)).toEqual(["entry-1", "entry-3"]);
    // The song is selected in two rows, so an action on the selection applies to it twice.
    expect(seen.selection?.songs.map(({ id }) => id)).toEqual(["song-a", "song-a"]);
  });

  it("selects only the row under a right-click outside the selection", () => {
    const seen = renderWithMenu(duplicates);

    fireEvent.click(row("entry-1"));
    fireEvent.contextMenu(row("entry-2"));

    expect(seen.selection?.items.map(({ key }) => key)).toEqual(["entry-2"]);
  });

  it("leaves songs that are not in the library out of what the menu acts on", () => {
    const seen = renderWithMenu([track("entry-1", "song-a", "Here"), track("entry-2", "song-gone", "song-gone", true)]);

    fireEvent.click(row("entry-1"));
    fireEvent.click(row("entry-2"), { metaKey: true });

    expect(seen.selection?.items).toHaveLength(2);
    expect(seen.selection?.songs.map(({ id }) => id)).toEqual(["song-a"]);
  });
});

describe("track list columns", () => {
  const song = songRow({ id: "song-a", title: "Here", artist: "Someone", album: "Somewhere", albumId: "album-a", track: 7, duration: 185 });
  const items: TrackListItem[] = [
    { type: "track", key: "a", song },
    { type: "track", key: "b", song: songRow({ id: "song-gone", title: "song-gone" }), unavailable: true },
  ];

  it.each([
    ["album", albumColumns],
    ["library", libraryColumns],
    ["compact", compactColumns],
  ])("draws a track with the %s columns", (_name, preset) => {
    render(<TrackList items={items} columns={preset} playingKey={null} />);

    expect(row("a").textContent).toContain("Here");
    expect(row("a").textContent).toContain("Someone");
    expect(row("a").textContent).toContain("3:05");
  });

  it("stands in for a song that is not in the library", () => {
    render(<TrackList items={items} columns={libraryColumns} />);

    expect(row("b").textContent).toContain("Not in local library");
    expect(row("b").textContent).not.toContain("0:00");
  });

  it("shows the playing indicator in place of the playing row's number", () => {
    render(<TrackList items={items} columns={albumColumns} playingKey="a" />);

    expect(row("a").querySelector(".playing-indicator")).toBeTruthy();
    expect(row("a").textContent).not.toContain("7");
  });
});
