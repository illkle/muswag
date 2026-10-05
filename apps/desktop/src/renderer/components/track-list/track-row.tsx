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
  hasMenu,
  className,
  style,
  ...props
}: {
  item: TrackItem;
  position: number;
  columns: readonly TrackColumn[];
  isSelected: boolean;
  isPlaying: boolean;
  /** Whether the row opens the context menu of the list it is in. */
  hasMenu: boolean;
} & React.ComponentProps<"div">) {
  const Row = hasMenu ? ContextMenuTrigger : "div";

  return (
    <Row
      data-track-key={item.key}
      data-selected={isSelected || undefined}
      data-playing={isPlaying || undefined}
      className={cn(
        "grid h-12 w-full items-center gap-3 px-4 text-left transition-colors duration-100 select-none",
        "hover:bg-muted/30",
        isSelected && "bg-muted/60 hover:bg-muted/70",
        item.unavailable && "opacity-50",
        className,
      )}
      style={{ gridTemplateColumns: columns.map(({ width }) => width).join(" "), ...style }}
      {...props}
    >
      {columns.map(({ id, className: cellClassName, Cell }) => (
        <div key={id} className={cn("min-w-0", cellClassName)}>
          <Cell item={item} position={position} isPlaying={isPlaying} />
        </div>
      ))}
    </Row>
  );
}
