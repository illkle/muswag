import { ContextMenuTrigger } from "#/components/ui/context-menu";
import { cn } from "#/lib/utils";

import type { TrackColumn } from "#/components/track-list/columns";
import type { TrackItem } from "#/components/track-list/types";

/**
 * A track in a track list. Every list draws its tracks with this one element, so whatever a row
 * reacts to (clicks, the context menu, and later dragging) is attached here through its props.
 */
export function TrackRow({
  item,
  position,
  columns,
  isSelected,
  isPlaying,
  isCursor,
  hasMenu,
  onPlay,
  className,
  ...props
}: {
  item: TrackItem;
  position: number;
  columns: readonly TrackColumn[];
  isSelected: boolean;
  isPlaying: boolean;
  /** The keyboard is on this row: it is outlined while the list has the keyboard's focus, and Tab reaches its controls. */
  isCursor: boolean;
  /** Whether the row opens the context menu of the list it is in. */
  hasMenu: boolean;
  /** Plays the track from this list, for the cells that offer it. */
  onPlay?: (() => void) | undefined;
} & React.ComponentProps<"div">) {
  const Row = hasMenu ? ContextMenuTrigger : "div";

  return (
    <Row
      role="row"
      aria-selected={isSelected}
      data-track-key={item.key}
      data-selected={isSelected || undefined}
      data-playing={isPlaying || undefined}
      data-cursor={isCursor || undefined}
      className={cn(
        "group/row grid h-12 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-100 select-none",
        "hover:bg-muted/50 group-focus-visible/list:data-cursor:ring-2 group-focus-visible/list:data-cursor:ring-ring/60 group-focus-visible/list:data-cursor:ring-inset",
        isSelected && "bg-muted hover:bg-muted",
        item.unavailable && "opacity-50",
        className,
      )}
      {...props}
    >
      {columns.map(({ id, className: cellClassName, Cell }) => (
        <div key={id} role="gridcell" className={cn("min-w-0", cellClassName)}>
          <Cell item={item} position={position} isPlaying={isPlaying} onPlay={onPlay} tabIndex={isCursor ? 0 : -1} />
        </div>
      ))}
    </Row>
  );
}
