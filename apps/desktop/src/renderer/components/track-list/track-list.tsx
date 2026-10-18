import { useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { TrackColumn } from "#/components/track-list/columns";
import { EMPTY_SELECTION, selectAll, selectForAction, selectOnClick, toggleSelected } from "#/components/track-list/selection";
import { TrackRow } from "#/components/track-list/track-row";
import { isTrackItem, type TrackItem, type TrackListItem, type TrackSelection } from "#/components/track-list/types";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "#/components/ui/context-menu";
import { scrollMemory } from "#/lib/scroll-memory";
import { cn } from "#/lib/utils";
import { TOP_HEIGHT } from "#/styles";

const TRACK_HEIGHT = 48;
const HEADING_HEIGHT = 40;
const NOTE_HEIGHT = 32;
/** The column header, and the gap between it and the first row. */
const HEADER_HEIGHT = 32;
const HEADER_GAP = 4;

/** Where a key that moves through the list takes the keyboard from the track at `at`, or `null` for any other key. */
function moveByKey(key: string, at: number, page: number, last: number): number | null {
  switch (key) {
    case "ArrowDown":
      return at + 1;
    case "ArrowUp":
      return at - 1;
    case "PageDown":
      return at + page;
    case "PageUp":
      return at - page;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * The tracks of `items`, and where each is among them by its index in `items`. A list of nothing but
 * tracks, such as the songs page, is taken as it is: nothing is copied, and a track's place is its index.
 */
function tracksOf(items: readonly TrackListItem[]): { tracks: readonly TrackItem[]; positions: readonly number[] | null } {
  if (items.every(isTrackItem)) return { tracks: items, positions: null };
  const tracks: TrackItem[] = [];
  const positions = items.map((item) => (item.type === "track" ? tracks.push(item) - 1 : -1));
  return { tracks, positions };
}

/** The key of the row an event happened in, or `null` outside the rows. */
const rowKeyOf = (event: { target: EventTarget }): string | null => (event.target as Element).closest<HTMLElement>("[data-track-key]")?.dataset.trackKey ?? null;

/**
 * The menu for the selected rows. It is drawn only while the menu is open, so the selection is read
 * from the rows, a pass over the whole list, only then.
 */
function SelectionMenu({ menu, tracks, keys }: { menu: (selection: TrackSelection) => ReactNode; tracks: readonly TrackItem[]; keys: ReadonlySet<string> }) {
  // Read from the rows that are there now, so keys of rows that have left the list select nothing.
  const selected = tracks.filter(({ key }) => keys.has(key));
  return menu({ items: selected, songs: selected.filter(({ unavailable }) => !unavailable).map(({ song }) => song) });
}

/**
 * A scrolling list of tracks, with headings between them where the list has sections. Selecting
 * rows works the same in every list; what a list shows and what its rows do is up to its props.
 *
 * The keyboard works on the list as a whole, which keeps the focus while one of its rows is the
 * one the keyboard is on. The arrows, Page Up, Page Down, Home and End move to a row and select it
 * as a click would: alone only that row, with Shift everything from the anchor to it. With Cmd or
 * Ctrl they move without selecting, and Cmd or Ctrl with Enter then adds the row to the selection
 * or takes it out. Enter alone is a double-click on the row, and the Menu key or Shift+F10 a
 * right-click. Space is left alone: it plays and pauses wherever the focus is.
 */
export function TrackList({
  items,
  columns,
  playingKey = null,
  showHeader = false,
  onActivate,
  menu,
  scrollId,
  rememberScroll = false,
  topPadding,
  bottomPadding,
  topContent,
  className,
}: {
  items: readonly TrackListItem[];
  columns: readonly TrackColumn[];
  /** The key of the row that is playing, when it is in this list. */
  playingKey?: string | null;
  /** Names the columns above the first row. */
  showHeader?: boolean;
  /** A double-click on a track, its play button, or Enter while the keyboard is on it. */
  onActivate?: (item: TrackItem) => void;
  /** The context menu for the selected rows. A right-click, or the Menu key, selects the row it is on first. */
  menu?: (selection: TrackSelection) => ReactNode;
  /** Restores the scroll position when navigating back to the page the list is on. */
  scrollId?: string;
  /** Comes back to where it was on any visit to the page, not only when going back to it. Needs `scrollId`. */
  rememberScroll?: boolean;
  topPadding?: number;
  bottomPadding?: number;
  /** Rendered above the rows, absolutely positioned inside the scrolled area — reserve room with `topPadding`. */
  topContent?: JSX.Element;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollRestorationId = scrollId === undefined ? undefined : "track-list-" + scrollId;
  // Without an id on the element nothing is stored, so this finds nothing to restore.
  const scrollEntry = useElementScrollRestoration({ id: scrollRestorationId ?? "track-list" });
  const memoryId = rememberScroll ? scrollRestorationId : undefined;
  const initialOffset = scrollEntry?.scrollY ?? (memoryId === undefined ? undefined : scrollMemory.get(memoryId));

  // What lies over the ends of the list, which a row scrolled to has to clear: the top bar over a list that pads for it, and the player.
  const scrollPaddingStart = Math.min(topPadding ?? 0, TOP_HEIGHT);
  const scrollPaddingEnd = bottomPadding ?? 0;

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item?.type === "track" ? TRACK_HEIGHT : item?.type === "heading" ? HEADING_HEIGHT : item?.type === "block" ? item.height : NOTE_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 10,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: (topPadding ?? 0) + (showHeader ? HEADER_HEIGHT + HEADER_GAP : 0),
    ...(bottomPadding === undefined ? {} : { paddingEnd: bottomPadding }),
    scrollPaddingStart,
    scrollPaddingEnd,
    // A scroll is drawn in the next frame rather than at once, which keeps scrolling smooth through a long list.
    useFlushSync: false,
  });

  const { tracks, positions } = useMemo(() => tracksOf(items), [items]);
  /** The keys of the tracks in order, which only clicks and keys need, so they are not kept between them. */
  const trackKeys = () => tracks.map(({ key }) => key);

  const gridTemplateColumns = useMemo(() => columns.map(({ width }) => width).join(" "), [columns]);

  const [selectionState, setSelectionState] = useState(EMPTY_SELECTION);

  // The rows are given one function to play with, which stays the same whatever function the page passes, so that a new one does not draw every row again.
  const onActivateRef = useRef(onActivate);
  useLayoutEffect(() => {
    onActivateRef.current = onActivate;
  });
  const [playRow] = useState(() => (item: TrackItem) => onActivateRef.current?.(item));

  /** The track the keyboard is on, by its key. A row that was clicked is where the keyboard goes on from. */
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  /** The id of that row's element, which is how the list, holding the focus itself, points at it. */
  const cursorRowId = useId();

  const virtualRows = rowVirtualizer.getVirtualItems();
  const cursorDrawn = cursorKey !== null && virtualRows.some(({ index }) => items[index]?.key === cursorKey);
  /** The header counts as a row of the grid. */
  const headerRows = showHeader ? 1 : 0;

  /** The first track in view below whatever lies over the top of the list. */
  const firstTrackInView = (): string | null => {
    const top = (rowVirtualizer.scrollOffset ?? 0) + scrollPaddingStart;
    const row = virtualRows.find(({ index, start }) => start >= top && items[index]?.type === "track");
    return (row ? items[row.index]?.key : tracks[0]?.key) ?? null;
  };

  const reveal = (key: string) => rowVirtualizer.scrollToIndex(items.findIndex((item) => item.key === key));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in something inside the list, such as a button of `topContent`, are its own.
    if (event.target !== event.currentTarget) return;

    const { key, shiftKey } = event;
    const mod = event.metaKey || event.ctrlKey;
    const at = cursorKey === null ? -1 : tracks.findIndex(({ key }) => key === cursorKey);

    if (key === "Escape") {
      setSelectionState(EMPTY_SELECTION);
    } else if (key === "a" && mod) {
      event.preventDefault();
      setSelectionState(selectAll(trackKeys()));
    } else if (key === "Enter") {
      const item = tracks[at];
      if (!item) return;
      if (mod) setSelectionState((state) => toggleSelected(state, item.key));
      else onActivate?.(item);
    } else if (menu && (key === "ContextMenu" || (key === "F10" && shiftKey))) {
      event.preventDefault();
      const onKey = tracks[at]?.key ?? firstTrackInView();
      if (onKey === null) return;
      setCursorKey(onKey);
      reveal(onKey);
      // Once the row is drawn as the one the keyboard is on, it is asked for its menu the way a right-click asks.
      requestAnimationFrame(() => {
        const row = document.getElementById(cursorRowId);
        if (!row) return;
        const { left, top, height } = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left + TRACK_HEIGHT, clientY: top + height / 2 }));
      });
    } else {
      const last = tracks.length - 1;
      const page = Math.max(1, Math.floor((event.currentTarget.clientHeight - scrollPaddingStart - scrollPaddingEnd) / TRACK_HEIGHT) - 1);
      const to = moveByKey(key, at, page, last);
      if (to === null) return;
      event.preventDefault();

      // With no row to move from, the keyboard starts on the first one in view.
      const toKey = at === -1 && key !== "Home" && key !== "End" ? firstTrackInView() : tracks[Math.min(Math.max(to, 0), last)]?.key;
      if (toKey == null) return;
      setCursorKey(toKey);
      if (!mod) {
        const order = trackKeys();
        setSelectionState((state) => selectOnClick(state, order, toKey, { toggle: false, range: shiftKey }));
      }
      // The first track comes with what is above it, which on a page with a header is that header.
      if (toKey === tracks[0]?.key) rowVirtualizer.scrollToOffset(0);
      else reveal(toKey);
    }
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const key = rowKeyOf(event);
    if (key === null) {
      setSelectionState(EMPTY_SELECTION);
      return;
    }
    const modifiers = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
    const order = trackKeys();
    setCursorKey(key);
    setSelectionState((state) => selectOnClick(state, order, key, modifiers));
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const key = rowKeyOf(event);
    const item = key === null ? undefined : tracks.find((track) => track.key === key);
    if (item) onActivate?.(item);
  };

  /** A right-click selects the row it is on first. Only rows have the menu, so one anywhere else in the list opens nothing. */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void }) => {
    const key = rowKeyOf(event);
    if (key === null) {
      event.preventBaseUIHandler?.();
      return;
    }
    setCursorKey(key);
    setSelectionState((state) => selectForAction(state, key));
  };

  // With a menu the list is what opens it, one trigger for all its rows rather than one for each.
  const List = menu ? ContextMenuTrigger : "div";

  const list = (
    <List
      ref={scrollRef}
      role="grid"
      aria-label="Tracks"
      aria-multiselectable
      aria-rowcount={items.length + headerRows}
      aria-activedescendant={cursorDrawn ? cursorRowId : undefined}
      data-scroll-restoration-id={scrollRestorationId}
      // The list has the focus rather than its rows, which come and go as it scrolls.
      tabIndex={0}
      // Text outside the rows stays selectable, as the trigger of a menu would not have it.
      className={cn("group/list scrollbar h-full overflow-y-auto outline-none select-auto", className)}
      onScroll={memoryId === undefined ? undefined : (event) => scrollMemory.set(memoryId, event.currentTarget.scrollTop)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={menu ? onContextMenu : undefined}
      onFocus={(event) => {
        // Reached with Tab, the list shows where the keyboard is at once. A click decides that itself.
        if (event.target === event.currentTarget && cursorKey === null && event.currentTarget.matches(":focus-visible")) setCursorKey(firstTrackInView());
      }}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }} className="relative w-full">
        {topContent}

        {showHeader ? (
          <div role="row" aria-rowindex={1} style={{ top: topPadding ?? 0, height: HEADER_HEIGHT }} className="absolute left-0 w-full px-2">
            <div style={{ gridTemplateColumns }} className="grid h-full items-center gap-3 border-b px-2">
              {columns.map(({ id, label, className: cellClassName }) => (
                <div key={id} role="columnheader" className={cn("min-w-0", cellClassName, "truncate text-xs font-normal text-muted-foreground")}>
                  {label}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {virtualRows.map((virtualRow) => {
          const item = items[virtualRow.index]!;
          const rowIndex = virtualRow.index + 1 + headerRows;

          return (
            <div key={item.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 flex w-full px-2">
              {item.type === "track" ? (
                <TrackRow
                  id={item.key === cursorKey ? cursorRowId : undefined}
                  rowIndex={rowIndex}
                  item={item}
                  position={positions ? positions[virtualRow.index]! : virtualRow.index}
                  columns={columns}
                  gridTemplateColumns={gridTemplateColumns}
                  isSelected={selectionState.keys.has(item.key)}
                  isPlaying={item.key === playingKey}
                  isCursor={item.key === cursorKey}
                  onPlay={onActivate && !item.unavailable ? playRow : undefined}
                />
              ) : item.type === "heading" ? (
                <div role="row" aria-rowindex={rowIndex} className="flex w-full items-end gap-2 px-2 pb-1.5 text-sm">
                  <div role="gridcell" aria-colspan={columns.length} className="flex min-w-0 items-end gap-2">
                    <span className="truncate font-semibold">{item.title}</span>
                    {item.subtitle ? <span className="truncate text-muted-foreground">{item.subtitle}</span> : null}
                  </div>
                </div>
              ) : item.type === "block" ? (
                <div role="row" aria-rowindex={rowIndex} className="flex w-full">
                  <div role="gridcell" aria-colspan={columns.length} className="min-w-0 flex-1">
                    {item.content}
                  </div>
                </div>
              ) : (
                <div role="row" aria-rowindex={rowIndex} className="flex w-full items-center px-2 text-xs">
                  <div role="gridcell" aria-colspan={columns.length} className="truncate text-muted-foreground">
                    {item.label}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </List>
  );

  if (!menu) return list;

  return (
    <ContextMenu>
      <ContextMenuContent>
        <SelectionMenu menu={menu} tracks={tracks} keys={selectionState.keys} />
      </ContextMenuContent>
      {list}
    </ContextMenu>
  );
}
