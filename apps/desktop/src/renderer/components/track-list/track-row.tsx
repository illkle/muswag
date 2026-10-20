import { memo } from "react";

import { cn } from "#/lib/utils";

import type { TrackColumn } from "#/components/track-list/columns";
import type { TrackItem } from "#/components/track-list/types";

/**
 * A track in a track list. Every list draws its tracks with this one element. The list handles the
 * clicks and the context menu of all its rows itself, finding the row by its `data-track-key`, so a
 * row is given only what it shows and is drawn again only when that changes, not each time the list
 * scrolls.
 */
export const TrackRow = memo(function TrackRow({
  id,
  rowIndex,
  item,
  position,
  columns,
  gridTemplateColumns,
  isSelected,
  isPlaying,
  isCursor,
  onPlay,
}: {
  id: string | undefined;
  /** Where the row is in the grid, counting from one. */
  rowIndex: number;
  item: TrackItem;
  position: number;
  columns: readonly TrackColumn[];
  gridTemplateColumns: string;
  isSelected: boolean;
  isPlaying: boolean;
  /** The keyboard is on this row: it is outlined while the list has the keyboard's focus, and Tab reaches its controls. */
  isCursor: boolean;
  /** Plays a track from the list, for the cells that offer it. Absent where the row cannot be played. */
  onPlay: ((item: TrackItem) => void) | undefined;
}) {
  const play = onPlay ? () => onPlay(item) : undefined;

  return (
    <div
      id={id}
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={isSelected}
      data-track-key={item.key}
      data-track-position={position}
      data-selected={isSelected || undefined}
      data-playing={isPlaying || undefined}
      data-cursor={isCursor || undefined}
      style={{ gridTemplateColumns }}
      className={cn(
        "group/row grid h-12 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-100 select-none",
        "hover:bg-muted/50 group-focus-visible/list:data-cursor:ring-2 group-focus-visible/list:data-cursor:ring-ring/60 group-focus-visible/list:data-cursor:ring-inset",
        isSelected && "bg-muted hover:bg-muted",
        item.unavailable && "opacity-50",
      )}
    >
      {columns.map(({ id: columnId, className: cellClassName, Cell }) => (
        <div key={columnId} role="gridcell" className={cn("min-w-0", cellClassName)}>
          <Cell item={item} position={position} isPlaying={isPlaying} onPlay={play} tabIndex={isCursor ? 0 : -1} />
        </div>
      ))}
    </div>
  );
});
