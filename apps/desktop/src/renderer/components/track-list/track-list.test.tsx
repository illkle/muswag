// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { songRow } from "@muswag/model";

vi.mock("@tanstack/react-router", () => ({
  useElementScrollRestoration: () => undefined,
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

const player = vi.hoisted(() => ({ status: "playing" }));
vi.mock("#/player/hooks", () => ({ usePlayerStatus: () => player.status }));
// The songs main could not play, by id.
const unplayable = vi.hoisted(() => new Set<string>());
vi.mock("#/queue/unplayable", () => ({ useSongIsUnplayable: (id: string) => unplayable.has(id) }));

vi.mock("#/library/album-cover-art", () => ({ useAlbumCoverArt: () => null }));

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
  player.status = "playing";
  unplayable.clear();
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

  it("marks a track that could not be played in place of its number", () => {
    unplayable.add("song-b");
    render(<TrackList items={[track("one", "song-a", "Fine"), track("two", "song-b", "Broken")]} columns={libraryColumns.filter(({ id }) => id === "position" || id === "duration")} />);

    expect(row("one").querySelector('[aria-label="Could not be played"]')).toBeNull();
    expect(row("one").textContent).toContain("1");
    expect(row("two").querySelector('[aria-label="Could not be played"]')).not.toBeNull();
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

  it("gives the menu the selection, and a right-click keeps a selection the row is part of", async () => {
    const seen = renderWithMenu(duplicates);

    fireEvent.click(row("entry-1"));
    fireEvent.click(row("entry-3"), { metaKey: true });
    fireEvent.contextMenu(row("entry-3"));

    expect(seen.selection?.items.map(({ key }) => key)).toEqual(["entry-1", "entry-3"]);
    // The song is selected in two rows, so an action on the selection applies to it twice.
    expect(seen.selection?.count).toBe(2);
    expect(await seen.selection?.songIds()).toEqual(["song-a", "song-a"]);
  });

  it("selects only the row under a right-click outside the selection", () => {
    const seen = renderWithMenu(duplicates);

    fireEvent.click(row("entry-1"));
    fireEvent.contextMenu(row("entry-2"));

    expect(seen.selection?.items.map(({ key }) => key)).toEqual(["entry-2"]);
  });

  it("opens no menu outside the rows, and reads the selection only once the menu opens", () => {
    const seen = renderWithMenu(duplicates);
    const list = document.querySelector<HTMLElement>('[role="grid"]')!;

    fireEvent.click(row("entry-1"));
    fireEvent.contextMenu(list);
    expect(seen.selection).toBeNull();
    expect(selectedKeys()).toEqual(["entry-1"]);

    fireEvent.contextMenu(row("entry-1"));
    expect(seen.selection?.items.map(({ key }) => key)).toEqual(["entry-1"]);
  });

  it("leaves songs that are not in the library out of what the menu acts on", async () => {
    const seen = renderWithMenu([track("entry-1", "song-a", "Here"), track("entry-2", "song-gone", "song-gone", true)]);

    fireEvent.click(row("entry-1"));
    fireEvent.click(row("entry-2"), { metaKey: true });
    fireEvent.contextMenu(row("entry-2"));

    expect(seen.selection?.items).toHaveLength(2);
    expect(seen.selection?.count).toBe(1);
    expect(await seen.selection?.songIds()).toEqual(["song-a"]);
  });
});

describe("TrackList with the keyboard", () => {
  const letters = [track("a", "a", "A"), track("b", "b", "B"), track("c", "c", "C"), track("d", "d", "D")];

  const renderList = (items: TrackListItem[] = letters, props: Partial<Pick<React.ComponentProps<typeof TrackList>, "onActivate" | "menu">> = {}) => {
    const { container } = render(<TrackList items={items} columns={columns} {...props} />);
    return container.firstElementChild as HTMLElement;
  };
  const press = (list: HTMLElement, key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => fireEvent.keyDown(list, { key, ...modifiers });
  /** The row the list says the keyboard is on. */
  const cursor = (list: HTMLElement) => document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.dataset.trackKey;

  it("is on the first track when the focus arrives by keyboard, with nothing selected yet", () => {
    const list = renderList([{ type: "heading", key: "disc:1", title: "Disc 1" }, ...letters]);

    // jsdom does not tell a focus that came by keyboard from one that came by mouse.
    vi.spyOn(list, "matches").mockImplementation((selector) => selector === ":focus-visible");
    act(() => list.focus());

    expect(cursor(list)).toBe("a");
    expect(selectedKeys()).toEqual([]);
  });

  it("waits for a key when the focus arrives by mouse", () => {
    const list = renderList();

    vi.spyOn(list, "matches").mockReturnValue(false);
    act(() => list.focus());

    expect(cursor(list)).toBeUndefined();
  });

  it("moves through the tracks with the arrows, selecting the one it is on and passing over headings", () => {
    const list = renderList([track("a", "a", "A"), { type: "heading", key: "disc:2", title: "Disc 2" }, track("b", "b", "B"), track("c", "c", "C")]);

    press(list, "ArrowDown");
    expect(cursor(list)).toBe("a");
    expect(selectedKeys()).toEqual(["a"]);

    press(list, "ArrowDown");
    expect(cursor(list)).toBe("b");
    expect(selectedKeys()).toEqual(["b"]);

    press(list, "ArrowUp");
    press(list, "ArrowUp");
    expect(cursor(list)).toBe("a");
    expect(selectedKeys()).toEqual(["a"]);
  });

  it("goes on from a row that was clicked", () => {
    const list = renderList();

    fireEvent.click(row("c"));
    press(list, "ArrowUp");

    expect(cursor(list)).toBe("b");
    expect(selectedKeys()).toEqual(["b"]);
  });

  it("goes to the ends with Home and End", () => {
    const list = renderList();

    press(list, "End");
    expect(selectedKeys()).toEqual(["d"]);

    press(list, "Home");
    expect(selectedKeys()).toEqual(["a"]);
  });

  it("extends the selection from the anchor with Shift, as a Shift-click does", () => {
    const list = renderList();

    fireEvent.click(row("b"));
    press(list, "ArrowDown", { shiftKey: true });
    press(list, "ArrowDown", { shiftKey: true });
    expect(selectedKeys()).toEqual(["b", "c", "d"]);

    press(list, "ArrowUp", { shiftKey: true });
    expect(selectedKeys()).toEqual(["b", "c"]);

    press(list, "Home", { shiftKey: true });
    expect(selectedKeys()).toEqual(["a", "b"]);
  });

  it("moves without selecting with Cmd or Ctrl, and toggles the row it is on with Enter, as a Cmd-click does", () => {
    const onActivate = vi.fn();
    const list = renderList(letters, { onActivate });

    fireEvent.click(row("a"));
    press(list, "ArrowDown", { metaKey: true });
    press(list, "ArrowDown", { ctrlKey: true });
    expect(cursor(list)).toBe("c");
    expect(selectedKeys()).toEqual(["a"]);

    press(list, "Enter", { metaKey: true });
    expect(selectedKeys()).toEqual(["a", "c"]);

    press(list, "Enter", { ctrlKey: true });
    expect(selectedKeys()).toEqual(["a"]);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("activates the row it is on with Enter, whatever else is selected", () => {
    const onActivate = vi.fn();
    const list = renderList(letters, { onActivate });

    fireEvent.click(row("a"));
    press(list, "ArrowDown", { shiftKey: true });
    press(list, "Enter");

    expect(onActivate).toHaveBeenCalledExactlyOnceWith(letters[1]);
  });

  it("leaves Space to whatever plays and pauses", () => {
    const onActivate = vi.fn();
    const list = renderList(letters, { onActivate });

    fireEvent.click(row("b"));
    // `fireEvent` answers whether the key was left with its default action.
    expect(press(list, " ")).toBe(true);

    expect(onActivate).not.toHaveBeenCalled();
    expect(selectedKeys()).toEqual(["b"]);
  });

  it("reaches tracks that are not drawn, scrolling to them", () => {
    const many = Array.from({ length: 500 }, (_, number) => track(`key-${number}`, `song-${number}`, `Song ${number}`));
    const onActivate = vi.fn();
    const scrollTo = vi.fn();
    const list = renderList(many, { onActivate });
    list.scrollTo = scrollTo;
    expect(document.querySelector('[data-track-key="key-499"]')).toBeNull();

    press(list, "End");
    press(list, "Enter");

    expect(onActivate).toHaveBeenCalledExactlyOnceWith(many[499]);
    expect(scrollTo).toHaveBeenCalled();
    // jsdom does not scroll, so the row is still not drawn and there is nothing for the list to point at.
    expect(list.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("moves by what fits in the list with Page Down and Page Up", () => {
    const many = Array.from({ length: 100 }, (_, number) => track(`key-${number}`, `song-${number}`, `Song ${number}`));
    const list = renderList(many);

    fireEvent.click(row("key-0"));
    press(list, "PageDown");
    // Twelve rows fit in the 600 pixels the list is given here, and a page keeps one of them in view.
    expect(selectedKeys()).toEqual(["key-11"]);

    press(list, "PageUp");
    press(list, "PageUp");
    expect(selectedKeys()).toEqual(["key-0"]);
  });

  it.each([
    ["the Menu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("opens the menu of the row it is on with %s", async (_name, key) => {
    const { container } = render(<TrackList items={letters} columns={columns} menu={(selection) => <div data-testid="menu">{selection.items.map((item) => item.key).join(",")}</div>} />);
    const list = container.firstElementChild as HTMLElement;

    fireEvent.click(row("a"));
    press(list, "ArrowDown", { metaKey: true });
    fireEvent.keyDown(list, key);

    // The row was not part of the selection, so the menu is for it alone, as after a right-click.
    expect((await screen.findByTestId("menu")).textContent).toBe("b");
  });

  it("lets Tab into the controls of the row it is on only", () => {
    const onActivate = vi.fn();
    const song = (id: string) => songRow({ id, title: id, artist: "Someone", artistId: "artist", album: "Somewhere", albumId: "album" });
    const items: TrackListItem[] = [
      { type: "track", key: "a", song: song("a") },
      { type: "track", key: "b", song: song("b") },
    ];
    render(<TrackList items={items} columns={albumColumns} onActivate={onActivate} />);
    const tabStops = (key: string) => [...row(key).querySelectorAll<HTMLElement>("button")].map((element) => element.tabIndex);

    fireEvent.click(row("b"));

    expect(tabStops("a")).toEqual([-1]);
    expect(tabStops("b")).toEqual([0]);

    fireEvent.click(row("b").querySelector("button")!);
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(items[1]);
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

  it.each(["paused", "ended", "stopped", "error"])("does not animate the indicator of a track that is %s", (status) => {
    player.status = status;
    render(<TrackList items={items} columns={albumColumns} playingKey="a" />);

    expect(row("a").querySelector(".playing-indicator")).toBeNull();
    expect(row("a").querySelector("svg")).toBeTruthy();
    expect(row("a").textContent).not.toContain("7");
  });
});

describe("TrackList of rows it loads as they are shown", () => {
  type TrackRows = import("#/components/track-list/types").TrackRows;
  const loadedTrack = (position: number) => track(`library:s${position}`, `s${position}`, `Song ${position}`) as import("#/components/track-list/types").TrackItem;

  /** A list of `count` rows of which those below `loaded` have loaded. */
  const rowsOf = (count: number, loaded: number) => {
    const shown: Array<[number, number]> = [];
    const songIds = vi.fn(async (spans: readonly { start: number; end: number }[]) => spans.flatMap(({ start, end }) => Array.from({ length: end - start }, (_, index) => `s${start + index}`)));
    const rows: TrackRows = {
      count,
      at: (position) => (position < loaded ? loadedTrack(position) : undefined),
      show: (start, end) => void shown.push([start, end]),
      songIds,
    };
    return { rows, shown, songIds };
  };
  const positionRow = (position: number) => document.querySelector<HTMLElement>(`[data-track-position="${position}"]`)!;
  const selectedPositions = () => [...document.querySelectorAll<HTMLElement>('[aria-selected="true"]')].map((element) => Number(element.dataset.trackPosition));

  it("draws a row that has not loaded as a placeholder, and says which rows it draws", () => {
    const { rows, shown } = rowsOf(250_000, 3);
    render(<TrackList rows={rows} columns={columns} />);

    expect(row("library:s2").textContent).toContain("Song 2");
    expect(positionRow(3).getAttribute("aria-busy")).toBe("true");
    expect(shown.at(-1)?.[0]).toBe(0);
    expect(document.querySelector('[role="grid"]')!.getAttribute("aria-rowcount")).toBe("250000");
  });

  it("selects by position, all of it as one span, and asks for the ids of what it does not hold", async () => {
    const { rows, songIds } = rowsOf(250_000, 5);
    const seen: { selection: TrackSelection | null } = { selection: null };
    const { container } = render(
      <TrackList
        rows={rows}
        columns={columns}
        menu={(selection) => {
          seen.selection = selection;
          return null;
        }}
      />,
    );

    fireEvent.click(positionRow(1));
    fireEvent.click(positionRow(6), { shiftKey: true });
    expect(selectedPositions()).toEqual([1, 2, 3, 4, 5, 6]);

    fireEvent.keyDown(container.firstElementChild!, { key: "a", metaKey: true });
    fireEvent.contextMenu(positionRow(2));
    expect(seen.selection?.count).toBe(250_000);
    // Only the rows it has loaded are items; the rest are asked for.
    expect(seen.selection?.items).toHaveLength(5);
    await seen.selection?.songIds();
    expect(songIds).toHaveBeenCalledWith([{ start: 0, end: 250_000 }]);
  });

  it("starts the selection and the keyboard over when rows come or go", () => {
    const { rows } = rowsOf(100, 10);
    const { container, rerender } = render(<TrackList rows={rows} columns={columns} />);
    const list = container.firstElementChild as HTMLElement;
    fireEvent.click(positionRow(8));
    expect(selectedPositions()).toEqual([8]);

    rerender(<TrackList rows={{ ...rows, count: 5 }} columns={columns} />);
    expect(selectedPositions()).toEqual([]);
    expect(list.hasAttribute("aria-activedescendant")).toBe(false);
    // The keyboard starts again from the first row in view rather than from past the end.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedPositions()).toEqual([0]);
  });

  it("acts on the songs the selected rows show when it holds them all, without asking", async () => {
    const { rows, songIds } = rowsOf(1_000, 10);
    const seen: { selection: TrackSelection | null } = { selection: null };
    render(
      <TrackList
        rows={rows}
        columns={columns}
        menu={(selection) => {
          seen.selection = selection;
          return null;
        }}
      />,
    );

    fireEvent.click(positionRow(2));
    fireEvent.click(positionRow(4), { shiftKey: true });
    fireEvent.contextMenu(positionRow(3));
    expect(await seen.selection?.songIds()).toEqual(["s2", "s3", "s4"]);
    expect(songIds).not.toHaveBeenCalled();
  });

  it("jumps to where what is typed starts, and lets Space go on it while typing", async () => {
    const { rows } = rowsOf(1_000, 1_000);
    const findPosition = vi.fn(async (text: string) => (text === "b" ? 2 : text === "b c" ? 3 : null));
    const { container } = render(<TrackList rows={rows} columns={columns} findPosition={findPosition} />);
    const list = container.firstElementChild as HTMLElement;

    await act(async () => {
      fireEvent.keyDown(list, { key: "b" });
    });
    expect(selectedPositions()).toEqual([2]);

    // Space goes on what is being typed rather than playing.
    expect(fireEvent.keyDown(list, { key: " " })).toBe(false);
    await act(async () => {
      fireEvent.keyDown(list, { key: "c" });
    });
    expect(findPosition).toHaveBeenLastCalledWith("b c");
    expect(selectedPositions()).toEqual([3]);
  });

  it("activates a loaded row on a double-click, and not one still loading", () => {
    const { rows } = rowsOf(100, 2);
    const onActivate = vi.fn();
    render(<TrackList rows={rows} columns={columns} onActivate={onActivate} />);

    fireEvent.doubleClick(positionRow(5));
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.doubleClick(positionRow(1));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ key: "library:s1" }));
  });

  it("drags the selection from a selected row, and only the row from another, and drops between the rows", async () => {
    const items = [track("a", "song-a", "A"), track("b", "song-b", "B"), track("c", "song-c", "C")];
    const onDrop = vi.fn();
    const { container } = render(<TrackList items={items} columns={columns} drop={{ gapAt: (index, after) => (after ? index + 1 : index), onDrop }} />);
    const list = container.firstElementChild as HTMLElement;
    // jsdom has no DataTransfer; this carries the types from the start of a drag to its drop, as the browser's would.
    const dataTransfer = { types: [] as string[], setData: (type: string) => dataTransfer.types.push(type), setDragImage: () => {}, clearData: () => {}, effectAllowed: "", dropEffect: "" };

    fireEvent.click(row("a"));
    fireEvent.click(row("b"), { shiftKey: true });
    fireEvent.dragStart(row("c"), { dataTransfer });
    expect(selectedKeys()).toEqual(["c"]);

    fireEvent.click(row("a"));
    fireEvent.click(row("b"), { shiftKey: true });
    fireEvent.dragStart(row("b"), { dataTransfer });
    expect(selectedKeys()).toEqual(["a", "b"]);

    // Rows are 48 pixels high: 60 is in the upper half of the second. jsdom has no DragEvent to carry where the pointer is.
    const at60 = (event: Event) => Object.defineProperty(event, "clientY", { value: 60 });
    fireEvent(list, at60(createEvent.dragOver(list, { dataTransfer })));
    expect(container.querySelector(".bg-brand")).not.toBeNull();
    // Dragend bubbles from the source, even when that is outside the drop target.
    fireEvent.dragEnd(window);
    expect(container.querySelector(".bg-brand")).toBeNull();
    fireEvent(list, at60(createEvent.dragOver(list, { dataTransfer })));
    // Leaving the list takes the line away; moving onto a row does not.
    const leaveTo = (to: Element | null) => fireEvent(list, Object.defineProperty(createEvent.dragLeave(list, { dataTransfer }), "relatedTarget", { value: to }));
    leaveTo(row("a"));
    expect(container.querySelector(".bg-brand")).not.toBeNull();
    leaveTo(null);
    expect(container.querySelector(".bg-brand")).toBeNull();
    fireEvent(list, at60(createEvent.dragOver(list, { dataTransfer })));
    fireEvent(list, at60(createEvent.drop(list, { dataTransfer })));
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ label: "2 songs" }), 1);
    await expect(onDrop.mock.calls[0]![0].songIds()).resolves.toEqual(["song-a", "song-b"]);
    expect(container.querySelector(".bg-brand")).toBeNull();
  });
});
