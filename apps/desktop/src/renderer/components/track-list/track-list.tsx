import { useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState, type JSX, type ReactNode } from "react";

import type { TrackColumn } from "#/components/track-list/columns";
import { EMPTY_SELECTION, selectAll, selectForAction, selectOnClick } from "#/components/track-list/selection";
import { TrackRow } from "#/components/track-list/track-row";
import { isTrackItem, type TrackItem, type TrackListItem, type TrackSelection } from "#/components/track-list/types";
import { ContextMenu, ContextMenuContent } from "#/components/ui/context-menu";
import { cn } from "#/lib/utils";

const TRACK_HEIGHT = 48;
const HEADING_HEIGHT = 40;
const NOTE_HEIGHT = 32;
/** The column header, and the gap between it and the first row. */
const HEADER_HEIGHT = 32;
const HEADER_GAP = 4;

/**
 * A scrolling list of tracks, with headings between them where the list has sections. Selecting
 * rows works the same in every list; what a list shows and what its rows do is up to its props.
 */
export function TrackList({
  items,
  columns,
  playingKey = null,
  showHeader = false,
  onActivate,
  menu,
  scrollId,
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
  /** A double-click on a track, its play button, or Enter while it alone is selected. */
  onActivate?: (item: TrackItem) => void;
  /** The context menu for the selected rows. A right-click selects the row under it first. */
  menu?: (selection: TrackSelection) => ReactNode;
  /** Restores the scroll position when navigating back to the page the list is on. */
  scrollId?: string;
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

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const type = items[index]?.type;
      return type === "track" ? TRACK_HEIGHT : type === "heading" ? HEADING_HEIGHT : NOTE_HEIGHT;
    },
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 10,
    ...(scrollEntry?.scrollY === undefined ? {} : { initialOffset: scrollEntry.scrollY }),
    paddingStart: (topPadding ?? 0) + (showHeader ? HEADER_HEIGHT + HEADER_GAP : 0),
    ...(bottomPadding === undefined ? {} : { paddingEnd: bottomPadding }),
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

  const list = (
    <div
      ref={scrollRef}
      data-scroll-restoration-id={scrollRestorationId}
      // Focusable so the list gets the keys pressed after a click in it.
      tabIndex={0}
      className={cn("scrollbar h-full overflow-y-auto outline-none", className)}
      onClick={(event) => {
        if (!(event.target as Element).closest("[data-track-key]")) setSelectionState(EMPTY_SELECTION);
      }}
      onKeyDown={(event) => {
        // Keys pressed in something inside the list, such as a button of `topContent`, are its own.
        if (event.target !== event.currentTarget) return;

        if (event.key === "Escape") {
          setSelectionState(EMPTY_SELECTION);
        } else if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          setSelectionState(selectAll(trackKeys));
        } else if (event.key === "Enter" && selection.items.length === 1) {
          onActivate?.(selection.items[0]!);
        }
      }}
    >
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px` }} className="relative w-full">
        {topContent}

        {showHeader ? (
          <div style={{ top: topPadding ?? 0, height: HEADER_HEIGHT }} className="absolute left-0 w-full px-2">
            <div style={{ gridTemplateColumns }} className="grid h-full items-center gap-3 border-b px-2">
              {columns.map(({ id, label, className: cellClassName }) => (
                <div key={id} className={cn("min-w-0", cellClassName, "truncate text-xs font-normal text-muted-foreground")}>
                  {label}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]!;

          return (
            <div key={item.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 flex w-full px-2">
              {item.type === "track" ? (
                <TrackRow
                  item={item}
                  position={positions[virtualRow.index]!}
                  columns={columns}
                  isSelected={selectionState.keys.has(item.key)}
                  isPlaying={item.key === playingKey}
                  hasMenu={menu !== undefined}
                  onPlay={onActivate && !item.unavailable ? () => onActivate(item) : undefined}
                  style={{ gridTemplateColumns }}
                  onClick={(event) => {
                    const modifiers = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
                    setSelectionState((state) => selectOnClick(state, trackKeys, item.key, modifiers));
                  }}
                  onDoubleClick={() => onActivate?.(item)}
                  onContextMenu={() => setSelectionState((state) => selectForAction(state, item.key))}
                />
              ) : item.type === "heading" ? (
                <div className="flex w-full items-end gap-2 px-2 pb-1.5 text-sm">
                  <span className="truncate font-semibold">{item.title}</span>
                  {item.subtitle ? <span className="truncate text-muted-foreground">{item.subtitle}</span> : null}
                </div>
              ) : (
                <div className="flex w-full items-center px-2 text-xs">
                  <span className="truncate text-muted-foreground">{item.label}</span>
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
