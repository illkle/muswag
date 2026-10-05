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
const TEXT_HEIGHT = 32;

/**
 * A scrolling list of tracks, with headings between them where the list has sections. Selecting
 * rows works the same in every list; what a list shows and what its rows do is up to its props.
 */
export function TrackList({
  items,
  columns,
  playingKey = null,
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
  /** A double-click on a track, or Enter while it alone is selected. */
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
    estimateSize: (index) => (items[index]?.type === "track" ? TRACK_HEIGHT : TEXT_HEIGHT),
    getItemKey: (index) => items[index]?.key ?? index,
    overscan: 10,
    ...(scrollEntry?.scrollY === undefined ? {} : { initialOffset: scrollEntry.scrollY }),
    ...(topPadding === undefined ? {} : { paddingStart: topPadding }),
    ...(bottomPadding === undefined ? {} : { paddingEnd: bottomPadding }),
  });

  const tracks = useMemo(() => items.filter(isTrackItem), [items]);
  const trackKeys = useMemo(() => tracks.map(({ key }) => key), [tracks]);
  /** Each track's place among the tracks, by its index in `items`. */
  const positions = useMemo(() => {
    let next = 0;
    return items.map((item) => (item.type === "track" ? next++ : -1));
  }, [items]);

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

        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]!;

          return (
            <div key={item.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 flex w-full">
              {item.type === "track" ? (
                <TrackRow
                  item={item}
                  position={positions[virtualRow.index]!}
                  columns={columns}
                  isSelected={selectionState.keys.has(item.key)}
                  isPlaying={item.key === playingKey}
                  hasMenu={menu !== undefined}
                  onClick={(event) => {
                    const modifiers = { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey };
                    setSelectionState((state) => selectOnClick(state, trackKeys, item.key, modifiers));
                  }}
                  onDoubleClick={() => onActivate?.(item)}
                  onContextMenu={() => setSelectionState((state) => selectForAction(state, item.key))}
                />
              ) : item.type === "heading" ? (
                <div className="flex h-8 w-full items-center gap-2 px-4 text-xs">
                  <span className="truncate font-medium opacity-70">{item.title}</span>
                  {item.subtitle ? <span className="truncate opacity-50">{item.subtitle}</span> : null}
                </div>
              ) : (
                <div className="flex h-8 w-full items-center px-4 text-xs">
                  <span className="truncate opacity-50">{item.label}</span>
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
