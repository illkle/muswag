import { useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { TrackColumn } from "#/components/track-list/columns";
import {
  EMPTY_SELECTION,
  EMPTY_SPANS,
  selectAll,
  selectAllPositions,
  selectForAction,
  selectOnClick,
  selectPositionForAction,
  selectPositionOnClick,
  spansHave,
  spansSize,
  togglePosition,
  toggleSelected,
  type SpanSelection,
} from "#/components/track-list/selection";
import { TrackRow } from "#/components/track-list/track-row";
import { isTrackItem, type TrackItem, type TrackListItem, type TrackRows, type TrackSelection } from "#/components/track-list/types";
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

/** Where among the tracks the row an event happened in is, or `null` outside the rows. */
const rowPositionOf = (event: { target: EventTarget }): number | null => {
  const position = (event.target as Element).closest<HTMLElement>("[data-track-position]")?.dataset.trackPosition;
  return position === undefined ? null : Number(position);
};

const NO_TRACKS = { tracks: [] as readonly TrackItem[], positions: null };

/** How long typing a few letters to jump to them waits for the next one before it starts over. */
const TYPEAHEAD_MS = 1_000;

/**
 * The menu for the selected rows. It is drawn only while the menu is open, so the selection is read
 * from the rows, a pass over the whole list, only then.
 */
function SelectionMenu({ menu, selection }: { menu: (selection: TrackSelection) => ReactNode; selection: () => TrackSelection }) {
  // Taken once, as the menu opens: a list of `TrackRows` starts its selection over when rows come or
  // go, and an open menu should still act on what was selected when it was opened.
  const [opened] = useState(selection);
  return menu(opened);
}

/** A row of a list of `TrackRows` that has not loaded yet. It can be selected like any other. */
function LoadingRow({ rowIndex, position, isSelected }: { rowIndex: number; position: number; isSelected: boolean }) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={isSelected}
      aria-busy
      data-track-position={position}
      className={cn("flex h-12 w-full items-center gap-3 rounded-md px-4 select-none", isSelected && "bg-muted")}
    >
      <div className="h-3 w-1/3 rounded bg-muted" />
    </div>
  );
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
  rows,
  findPosition,
  headerCell,
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
}: (
  | { items: readonly TrackListItem[]; rows?: undefined }
  /** The rows of a list too long to hold whole. They select by position, and a change to how many there are clears the selection. */
  | { rows: TrackRows; items?: undefined }
) & {
  /**
   * Where the first track at or after what was typed is, for jumping to it by typing the first letters
   * of what the list is in order of. Space goes on what was typed while it is being typed.
   */
  findPosition?: (text: string) => Promise<number | null>;
  /** What the header shows for a column, such as a way to sort by it, in place of its label. */
  headerCell?: (column: TrackColumn) => ReactNode;
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

  /** What the list draws at `index`: in a list of `TrackRows` a track, or `undefined` while it loads. */
  const itemAt = (index: number): TrackListItem | undefined => (rows ? rows.at(index) : items[index]);
  const count = rows ? rows.count : items.length;

  const rowVirtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = itemAt(index);
      return !item || item.type === "track" ? TRACK_HEIGHT : item.type === "heading" ? HEADING_HEIGHT : item.type === "block" ? item.height : NOTE_HEIGHT;
    },
    // A row of `TrackRows` is its position, whether or not it has loaded.
    getItemKey: (index) => (rows ? index : (items[index]?.key ?? index)),
    overscan: 10,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: (topPadding ?? 0) + (showHeader ? HEADER_HEIGHT + HEADER_GAP : 0),
    ...(bottomPadding === undefined ? {} : { paddingEnd: bottomPadding }),
    scrollPaddingStart,
    scrollPaddingEnd,
    // A scroll is drawn in the next frame rather than at once, which keeps scrolling smooth through a long list.
    useFlushSync: false,
  });

  const { tracks, positions } = useMemo(() => (items ? tracksOf(items) : NO_TRACKS), [items]);
  /** How many tracks there are, and the one at a position among them. Every row of `TrackRows` is a track. */
  const trackCount = rows ? rows.count : tracks.length;
  const trackAt = (position: number): TrackItem | undefined => (rows ? rows.at(position) : tracks[position]);
  /** Where among the tracks the row at `index` is. */
  const positionOf = (index: number) => (rows ? index : positions ? positions[index]! : index);
  /** The keys of the tracks in order, which only clicks and keys need, so they are not kept between them. */
  const trackKeys = () => tracks.map(({ key }) => key);

  const gridTemplateColumns = useMemo(() => columns.map(({ width }) => width).join(" "), [columns]);

  /**
   * The track the keyboard is on. A row that was clicked is where the keyboard goes on from. A list of
   * items follows it by its key wherever it moves; a list of `TrackRows` keeps to its position.
   */
  const [cursor, setCursor] = useState<{ position: number; key: string | null } | null>(null);

  // A list of items selects by key, which holds wherever its rows move. A list of `TrackRows` does not
  // know every key, and selects by position; positions move when rows come or go, so it starts over.
  const [selectionState, setSelectionState] = useState(EMPTY_SELECTION);
  const [spanState, setSpanState] = useState<SpanSelection>(EMPTY_SPANS);
  const [spansFor, setSpansFor] = useState(count);
  if (rows && spansFor !== count) {
    setSpansFor(count);
    setSpanState(EMPTY_SPANS);
    // A position the keyboard was on may be past the end now, or another song's.
    setCursor(null);
  }
  const isSelected = (position: number, item: TrackItem | undefined) => (rows ? spansHave(spanState.spans, position) : item !== undefined && selectionState.keys.has(item.key));
  const clearSelection = () => (rows ? setSpanState(EMPTY_SPANS) : setSelectionState(EMPTY_SELECTION));
  const selectEverything = () => (rows ? setSpanState(selectAllPositions(rows.count)) : setSelectionState(selectAll(trackKeys())));
  const selectAt = (position: number, modifiers: { toggle: boolean; range: boolean }) => {
    if (rows) return setSpanState((state) => selectPositionOnClick(state, position, modifiers));
    const key = tracks[position]?.key;
    if (key === undefined) return;
    const order = trackKeys();
    setSelectionState((state) => selectOnClick(state, order, key, modifiers));
  };
  const toggleAt = (position: number) => {
    if (rows) return setSpanState((state) => togglePosition(state, position));
    const key = tracks[position]?.key;
    if (key !== undefined) setSelectionState((state) => toggleSelected(state, key));
  };
  const selectForActionAt = (position: number) => {
    if (rows) return setSpanState((state) => selectPositionForAction(state, position));
    const key = tracks[position]?.key;
    if (key !== undefined) setSelectionState((state) => selectForAction(state, key));
  };

  /** What the menu acts on, read only when it opens. */
  const currentSelection = (): TrackSelection => {
    if (rows) {
      const { spans } = spanState;
      const held: TrackItem[] = [];
      for (const { start, end } of spans) {
        for (let position = start; position < end; position++) {
          const item = rows.at(position);
          if (item) held.push(item);
        }
      }
      const count = spansSize(spans);
      // Main reads positions as the library is now, which a change may have moved since the rows on
      // screen were read; a selection of those rows only is what they show.
      if (held.length === count) {
        const ids = held.map(({ song }) => song.id);
        return { items: held, count, songIds: () => Promise.resolve(ids) };
      }
      return { items: held, count, songIds: () => rows.songIds(spans) };
    }
    // Read from the rows that are there now, so keys of rows that have left the list select nothing.
    const selected = tracks.filter(({ key }) => selectionState.keys.has(key));
    const ids = selected.filter(({ unavailable }) => !unavailable).map(({ song }) => song.id);
    return { items: selected, count: ids.length, songIds: () => Promise.resolve(ids) };
  };

  // The rows are given one function to play with, which stays the same whatever function the page passes, so that a new one does not draw every row again.
  const onActivateRef = useRef(onActivate);
  useLayoutEffect(() => {
    onActivateRef.current = onActivate;
  });
  const [playRow] = useState(() => (item: TrackItem) => onActivateRef.current?.(item));

  const cursorAt = cursor === null ? -1 : rows || cursor.key === null ? cursor.position : tracks.findIndex(({ key }) => key === cursor.key);
  const moveCursor = (position: number) => setCursor({ position, key: trackAt(position)?.key ?? null });
  /** The id of that row's element, which is how the list, holding the focus itself, points at it. */
  const cursorRowId = useId();

  const virtualRows = rowVirtualizer.getVirtualItems();
  const cursorDrawn = cursorAt !== -1 && virtualRows.some(({ index }) => positionOf(index) === cursorAt && itemAt(index)?.type === "track");
  /** The header counts as a row of the grid. */
  const headerRows = showHeader ? 1 : 0;

  // The rows of `TrackRows` that are drawn, so that those not loaded yet load.
  const firstDrawn = virtualRows[0]?.index ?? 0;
  const lastDrawn = virtualRows.at(-1)?.index ?? -1;
  useLayoutEffect(() => {
    if (rows && lastDrawn >= firstDrawn) rows.show(firstDrawn, lastDrawn + 1);
  }, [rows, firstDrawn, lastDrawn]);

  /** The first track in view below whatever lies over the top of the list. */
  const firstTrackInView = (): number | null => {
    const top = (rowVirtualizer.scrollOffset ?? 0) + scrollPaddingStart;
    const row = virtualRows.find(({ index, start }) => start >= top && (rows ? true : items[index]?.type === "track"));
    if (row) return positionOf(row.index);
    return trackCount > 0 ? 0 : null;
  };

  /** Scrolls the track at `position` into view. The first comes with what is above it, which on a page with a header is that header. */
  const reveal = (position: number) => {
    if (position === 0) rowVirtualizer.scrollToOffset(0);
    else rowVirtualizer.scrollToIndex(rows || !positions ? position : positions.indexOf(position));
  };

  /** Puts the keyboard on the track at `position`, selecting it as a click would unless `select` is false, and shows it. */
  const goTo = (position: number, { select = true, range = false } = {}) => {
    moveCursor(position);
    if (select) selectAt(position, { toggle: false, range });
    reveal(position);
  };

  // What has been typed to jump to, until a moment passes without another key.
  const typed = useRef({ text: "", at: 0, search: 0 });
  const typeahead = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    const { key } = event;
    if (!findPosition || key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return false;
    const now = performance.now();
    const going = typed.current.text !== "" && now - typed.current.at < TYPEAHEAD_MS;
    // Space plays and pauses, unless it goes on what is being typed.
    if (key === " " && !going) return false;
    event.preventDefault();
    event.stopPropagation();
    const text = (going ? typed.current.text : "") + key;
    const search = typed.current.search + 1;
    typed.current = { text, at: now, search };
    findPosition(text).then(
      (position) => {
        // Only the latest of the searches goes anywhere.
        if (position === null || typed.current.search !== search) return;
        goTo(Math.min(Math.max(position, 0), trackCount - 1));
      },
      // Not finding where to jump leaves the list where it is.
      (cause: unknown) => console.error("[track-list] could not find where the typed text starts", cause),
    );
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in something inside the list, such as a button of `topContent`, are its own.
    if (event.target !== event.currentTarget) return;

    const { key, shiftKey } = event;
    const mod = event.metaKey || event.ctrlKey;
    const at = cursorAt;

    if (key === "Escape") {
      clearSelection();
    } else if (key === "a" && mod) {
      event.preventDefault();
      selectEverything();
    } else if (key === "Enter") {
      if (at === -1) return;
      if (mod) return toggleAt(at);
      const item = trackAt(at);
      if (item) onActivate?.(item);
    } else if (menu && (key === "ContextMenu" || (key === "F10" && shiftKey))) {
      event.preventDefault();
      const onKey = at !== -1 ? at : firstTrackInView();
      if (onKey === null) return;
      moveCursor(onKey);
      reveal(onKey);
      // Once the row is drawn as the one the keyboard is on, it is asked for its menu the way a right-click asks.
      requestAnimationFrame(() => {
        const row = document.getElementById(cursorRowId);
        if (!row) return;
        const { left, top, height } = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left + TRACK_HEIGHT, clientY: top + height / 2 }));
      });
    } else {
      const last = trackCount - 1;
      const page = Math.max(1, Math.floor((event.currentTarget.clientHeight - scrollPaddingStart - scrollPaddingEnd) / TRACK_HEIGHT) - 1);
      const to = moveByKey(key, at, page, last);
      if (to === null) {
        typeahead(event);
        return;
      }
      event.preventDefault();

      // With no row to move from, the keyboard starts on the first one in view.
      const toPosition = at === -1 && key !== "Home" && key !== "End" ? firstTrackInView() : last < 0 ? null : Math.min(Math.max(to, 0), last);
      if (toPosition === null) return;
      goTo(toPosition, { select: !mod, range: shiftKey });
    }
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const position = rowPositionOf(event);
    if (position === null) return clearSelection();
    moveCursor(position);
    selectAt(position, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey });
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const position = rowPositionOf(event);
    const item = position === null ? undefined : trackAt(position);
    if (item) onActivate?.(item);
  };

  /** A right-click selects the row it is on first. Only rows have the menu, so one anywhere else in the list opens nothing. */
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void }) => {
    const position = rowPositionOf(event);
    if (position === null) {
      event.preventBaseUIHandler?.();
      return;
    }
    moveCursor(position);
    selectForActionAt(position);
  };

  // With a menu the list is what opens it, one trigger for all its rows rather than one for each.
  const List = menu ? ContextMenuTrigger : "div";

  const list = (
    <List
      ref={scrollRef}
      role="grid"
      aria-label="Tracks"
      aria-multiselectable
      aria-rowcount={count + headerRows}
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
        if (event.target !== event.currentTarget || cursor !== null || !event.currentTarget.matches(":focus-visible")) return;
        const first = firstTrackInView();
        if (first !== null) moveCursor(first);
      }}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }} className="relative w-full">
        {topContent}

        {showHeader ? (
          <div role="row" aria-rowindex={1} style={{ top: topPadding ?? 0, height: HEADER_HEIGHT }} className="absolute left-0 w-full px-2">
            <div style={{ gridTemplateColumns }} className="grid h-full items-center gap-3 border-b px-2">
              {columns.map((column) => (
                <div key={column.id} role="columnheader" className={cn("min-w-0", column.className, "truncate text-xs font-normal text-muted-foreground")}>
                  {headerCell?.(column) ?? column.label}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {virtualRows.map((virtualRow) => {
          const item = itemAt(virtualRow.index);
          const rowIndex = virtualRow.index + 1 + headerRows;
          const position = positionOf(virtualRow.index);
          const isCursor = position === cursorAt;

          return (
            <div key={virtualRow.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 flex w-full px-2">
              {!item ? (
                <LoadingRow rowIndex={rowIndex} position={position} isSelected={isSelected(position, undefined)} />
              ) : item.type === "track" ? (
                <TrackRow
                  id={isCursor ? cursorRowId : undefined}
                  rowIndex={rowIndex}
                  item={item}
                  position={position}
                  columns={columns}
                  gridTemplateColumns={gridTemplateColumns}
                  isSelected={isSelected(position, item)}
                  isPlaying={item.key === playingKey}
                  isCursor={isCursor}
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
        <SelectionMenu menu={menu} selection={currentSelection} />
      </ContextMenuContent>
      {list}
    </ContextMenu>
  );
}
