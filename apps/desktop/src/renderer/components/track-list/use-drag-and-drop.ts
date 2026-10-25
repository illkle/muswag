import type { VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useState, type DragEvent } from "react";

import { rowPositionOf } from "#/components/track-list/track-row";
import type { TrackSelection } from "#/components/track-list/types";
import type { TrackListSelection } from "#/components/track-list/use-selection";
import { draggedSongs, startSongDrag, type SongDrag } from "#/lib/song-drag";

/** Where in a list songs can be dropped. */
export type TrackListDrop = {
  /** What the list is called in `SongDrag.rows`, so that its own rows show as moving rather than being added. */
  list?: string;
  /** Whether songs of `drag` can be dropped in the list at all. */
  accepts?: (drag: SongDrag) => boolean;
  /**
   * Where songs dropped on the row at `index`, on its lower half when `after`, go: the index of the row
   * they go before, the number of rows for after the last, or `null` where they cannot go.
   */
  gapAt: (index: number, after: boolean) => number | null;
  onDrop: (drag: SongDrag, gap: number) => void;
};

/**
 * Dragging the selected rows of a list as `dragOf` says, and, with `drop`, dropping songs between its
 * rows, of which `virtualRows` are those drawn. `props` go on the list, which finds the row under the
 * pointer itself; `dropGap` is where songs dragged over it would go, as `drop.gapAt` says.
 */
export function useDragAndDrop({
  selection,
  dragOf,
  drop,
  virtualRows,
}: {
  selection: TrackListSelection;
  dragOf: (selection: TrackSelection) => SongDrag;
  drop: TrackListDrop | undefined;
  virtualRows: readonly VirtualItem[];
}) {
  /** A drag selects the row it starts on first, as a right-click does. */
  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const position = rowPositionOf(event);
    if (position === null) return;
    const dragged = selection.from(position);
    if (dragged.count === 0) return event.preventDefault();
    selection.moveCursor(position);
    selection.selectForAction(position);
    startSongDrag(event, dragOf(dragged));
  };

  const [dropGap, setDropGap] = useState<number | null>(null);
  useEffect(() => {
    if (dropGap === null) return;
    // A cancelled drag ends at its source, which may be in another list.
    const clear = () => setDropGap(null);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [dropGap]);
  const gapUnder = (event: DragEvent<HTMLDivElement>): number | null => {
    const drag = draggedSongs(event);
    if (!drop || !drag || drop.accepts?.(drag) === false) return null;
    const y = event.clientY - event.currentTarget.getBoundingClientRect().top + event.currentTarget.scrollTop;
    const row = virtualRows.find(({ end }) => y < end) ?? virtualRows.at(-1);
    return row ? drop.gapAt(row.index, y >= row.start + row.size / 2) : null;
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const gap = gapUnder(event);
    if (gap !== dropGap) setDropGap(gap);
    if (gap === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drop?.list !== undefined && draggedSongs(event)?.rows?.list === drop.list ? "move" : "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // Moving onto a row is still over the list.
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropGap(null);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const drag = draggedSongs(event);
    const gap = gapUnder(event);
    setDropGap(null);
    if (gap === null || !drag) return;
    event.preventDefault();
    drop?.onDrop(drag, gap);
  };

  return {
    dropGap,
    props: {
      onDragStart,
      onDragOver: drop ? onDragOver : undefined,
      onDragLeave: drop ? onDragLeave : undefined,
      onDrop: drop ? onDrop : undefined,
    },
  };
}
