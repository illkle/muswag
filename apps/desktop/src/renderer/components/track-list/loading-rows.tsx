import { useMemo, type CSSProperties } from "react";

import type { GhostShape, TrackColumn } from "#/components/track-list/columns";
import { TRACK_HEIGHT } from "#/components/track-list/track-row";
import { cn } from "#/lib/utils";

/** A mask of `shapes`, a cell of each of a few rows in turn, as a column of `LoadingRows` repeats it down the list. */
function ghostMask(rows: readonly (readonly GhostShape[])[]): CSSProperties {
  const rects = rows.flatMap((shapes, row) =>
    shapes.map(({ x = 0, y, width, height, radius = Math.min(4, height / 2) }) => `<rect x="${x}%" y="${row * TRACK_HEIGHT + y}" width="${width}%" height="${height}" rx="${radius}"/>`),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${rects.join("")}</svg>`;
  return {
    maskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    maskRepeat: "repeat-y",
    maskSize: `100% ${rows.length * TRACK_HEIGHT}px`,
  };
}

/**
 * What every row of a list of `TrackRows` shows until it has loaded: the shapes of each column's
 * `ghost`, laid out on the rows' grid and drawn under all the rows at once by the browser itself. A
 * fast drag of the scrollbar scrolls further than the rows drawn before the list has drawn the rows
 * there, and this is in their places rather than nothing. A row that has loaded covers it.
 */
export function LoadingRows({ top, count, columns, gridTemplateColumns }: { top: number; count: number; columns: readonly TrackColumn[]; gridTemplateColumns: string }) {
  const masks = useMemo(() => columns.map(({ ghost }) => (ghost ? ghostMask(ghost) : undefined)), [columns]);
  return (
    <div aria-hidden className="absolute left-0 w-full px-2" style={{ top, height: count * TRACK_HEIGHT }}>
      <div style={{ gridTemplateColumns }} className="grid h-full gap-3 px-2">
        {columns.map(({ id }, index) => (
          <div key={id} className={cn(masks[index] && "bg-muted")} style={masks[index]} />
        ))}
      </div>
    </div>
  );
}

/** A row of a list of `TrackRows` that has not loaded yet, which shows `LoadingRows` under it. It can be selected like any other. */
export function LoadingRow({ rowIndex, position, isSelected }: { rowIndex: number; position: number; isSelected: boolean }) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={isSelected}
      aria-busy
      draggable
      data-track-position={position}
      className={cn("h-12 w-full rounded-lg border-2 border-transparent bg-clip-padding select-none", isSelected && "bg-muted")}
    />
  );
}
