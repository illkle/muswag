import { useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";

import type { TrackColumn } from "#/components/track-list/columns";
import { EMPTY_SELECTION, selectAll, selectForAction, selectOnClick, toggleSelected } from "#/components/track-list/selection";
import { TrackRow } from "#/components/track-list/track-row";
import { isTrackItem, type TrackItem, type TrackListItem, type TrackSelection } from "#/components/track-list/types";
import { ContextMenu, ContextMenuContent } from "#/components/ui/context-menu";
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
      const type = items[index]?.type;
      return type === "track" ? TRACK_HEIGHT : type === "heading" ? HEADING_HEIGHT : NOTE_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 10,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: (topPadding ?? 0) + (showHeader ? HEADER_HEIGHT + HEADER_GAP : 0),
    ...(bottomPadding === undefined ? {} : { paddingEnd: bottomPadding }),
    scrollPaddingStart,
    scrollPaddingEnd,
  });

  const tracks = useMemo(() => items.filter(isTrackItem), [items]);
  const trackKeys = useMemo(() => tracks.map(({ key }) => key), [tracks]);
  /** Each track's place among the tracks, by its index in `items`. */
  const positions = useMemo(() => {
    let next = 0;
    return items.map((item) => (item.type === "track" ? next++ : -1));
  }, [items]);

  const gridTemplateColumns = useMemo(() => columns.map(({ width }) => width).join(" "), [columns]);

  const [selectionState, setSelectionState] = useState(EMPTY_SELECTION);
  // Read from the rows that are there now, so keys of rows that have left the list select nothing.
  const selection = useMemo((): TrackSelection => {
    const selected = tracks.filter(({ key }) => selectionState.keys.has(key));
    return { items: selected, songs: selected.filter(({ unavailable }) => !unavailable).map(({ song }) => song) };
  }, [tracks, selectionState]);

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
    return (row ? items[row.index]?.key : trackKeys[0]) ?? null;
  };

  const reveal = (key: string) => rowVirtualizer.scrollToIndex(items.findIndex((item) => item.key === key));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in something inside the list, such as a button of `topContent`, are its own.
    if (event.target !== event.currentTarget) return;

    const { key, shiftKey } = event;
    const mod = event.metaKey || event.ctrlKey;
    const at = cursorKey === null ? -1 : trackKeys.indexOf(cursorKey);

    if (key === "Escape") {
      setSelectionState(EMPTY_SELECTION);
    } else if (key === "a" && mod) {
      event.preventDefault();
      setSelectionState(selectAll(trackKeys));
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
      const last = trackKeys.length - 1;
      const page = Math.max(1, Math.floor((event.currentTarget.clientHeight - scrollPaddingStart - scrollPaddingEnd) / TRACK_HEIGHT) - 1);
      const to = moveByKey(key, at, page, last);
      if (to === null) return;
      event.preventDefault();

      // With no row to move from, the keyboard starts on the first one in view.
      const toKey = at === -1 && key !== "Home" && key !== "End" ? firstTrackInView() : trackKeys[Math.min(Math.max(to, 0), last)];
      if (toKey == null) return;
      setCursorKey(toKey);
      if (!mod) setSelectionState((state) => selectOnClick(state, trackKeys, toKey, { toggle: false, range: shiftKey }));
      // The first track comes with what is above it, which on a page with a header is that header.
      if (toKey === trackKeys[0]) rowVirtualizer.scrollToOffset(0);
      else reveal(toKey);
    }
  };

  const list = (
    <div
      ref={scrollRef}
      role="grid"
      aria-label="Tracks"
      aria-multiselectable
      aria-rowcount={items.length + headerRows}
      aria-activedescendant={cursorDrawn ? cursorRowId : undefined}
      data-scroll-restoration-id={scrollRestorationId}
      // The list has the focus rather than its rows, which come and go as it scrolls.
      tabIndex={0}
      className={cn("group/list scrollbar h-full overflow-y-auto outline-none", className)}
      onScroll={memoryId === undefined ? undefined : (event) => scrollMemory.set(memoryId, event.currentTarget.scrollTop)}
      onClick={(event) => {
        if (!(event.target as Element).closest("[data-track-key]")) setSelectionState(EMPTY_SELECTION);
      }}
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
                  aria-rowindex={rowIndex}
                  item={item}
                  position={positions[virtualRow.index]!}
                  columns={columns}
                  isSelected={selectionState.keys.has(item.key)}
                  isPlaying={item.key === playingKey}
                  isCursor={item.key === cursorKey}
                  hasMenu={menu !== undefined}
                  onPlay={onActivate && !item.unavailable ? () => onActivate(item) : undefined}
                  style={{ gridTemplateColumns }}
                  onClick={(event) => {
                    const modifiers = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
                    setCursorKey(item.key);
                    setSelectionState((state) => selectOnClick(state, trackKeys, item.key, modifiers));
                  }}
                  onDoubleClick={() => onActivate?.(item)}
                  onContextMenu={() => {
                    setCursorKey(item.key);
                    setSelectionState((state) => selectForAction(state, item.key));
                  }}
                />
              ) : item.type === "heading" ? (
                <div role="row" aria-rowindex={rowIndex} className="flex w-full items-end gap-2 px-2 pb-1.5 text-sm">
                  <div role="gridcell" aria-colspan={columns.length} className="flex min-w-0 items-end gap-2">
                    <span className="truncate font-semibold">{item.title}</span>
                    {item.subtitle ? <span className="truncate text-muted-foreground">{item.subtitle}</span> : null}
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
    </div>
  );

  if (!menu) return list;

  return (
    <ContextMenu>
      <ContextMenuContent>{menu(selection)}</ContextMenuContent>
      {list}
    </ContextMenu>
  );
}
