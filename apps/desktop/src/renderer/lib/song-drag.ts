import { useEffect, useState, type DragEvent } from "react";

/**
 * Songs being dragged within the window, from a track list, an album, a playlist or the player, to a
 * playlist or the queue. The browser carries only a marker of the drag; what is dragged stays here, so
 * the songs can be read when they are dropped rather than when the drag starts.
 */
export type SongDrag = {
  /** What the drag shows next to the pointer. */
  label: string;
  /** The songs, in order. A song dragged in two rows is here twice. */
  songIds: () => Promise<readonly string[]>;
  /**
   * The rows dragged out of a list that can move its rows, such as the queue or a playlist, by the keys that
   * list moves them by. A drop back in that list moves them rather than adding their songs again.
   */
  rows?: { list: string; keys: readonly string[] };
  /** The playlist dragged as a whole from the sidebar, which goes only into the queue or the page of another playlist. */
  playlistId?: string;
};

const SONGS_TYPE = "application/x-muswag-songs";

/** The drag that started last. A drag that left the window and came back is still this one; any other is not marked as songs. */
let current: SongDrag | null = null;

/** Starts dragging `drag` from the element of `event`. */
export function startSongDrag(event: DragEvent, drag: SongDrag): void {
  current = drag;
  event.dataTransfer.effectAllowed = "copyMove";
  // Only the marker: a link dragged by its row would also carry its address, which a field such as the search would take as text.
  event.dataTransfer.clearData();
  event.dataTransfer.setData(SONGS_TYPE, "");

  // The pointer carries what is dragged as a label, not as a picture of the row or tile it started on.
  const image = document.createElement("div");
  image.textContent = drag.label;
  image.className = "fixed top-0 -left-[1000px] max-w-64 truncate rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground";
  document.body.append(image);
  event.dataTransfer.setDragImage(image, -12, -12);
  // The browser takes its picture of the element right away.
  setTimeout(() => image.remove());

  // No pointer events reach the page while it drags, so the browser keeps working out :hover from where the
  // drag started; after a move in a list another row is there. Rows show no hover until the pointer moves (`styles.css`).
  const root = document.documentElement;
  root.dataset.songDrag = "";
  window.addEventListener("pointermove", () => delete root.dataset.songDrag, { once: true });
}

/** The songs `event` drags, or `null` for a drag of anything else, such as a file. */
export const draggedSongs = (event: DragEvent): SongDrag | null => (event.dataTransfer.types.includes(SONGS_TYPE) ? current : null);

/**
 * Makes an element a place to drop songs on, unless `disabled`, of the drags it `accepts`: `over` is whether
 * such songs are being dragged over it, and `props` go on the element. A drop of anything else is left to the browser.
 */
export function useSongDrop(onDrop: (drag: SongDrag) => void, { disabled = false, accepts }: { disabled?: boolean; accepts?: (drag: SongDrag) => boolean } = {}) {
  const [over, setOver] = useState(false);
  if (disabled && over) setOver(false);

  useEffect(() => {
    if (!over) return;
    const clear = () => setOver(false);
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, [over]);

  /** The songs `event` drags, when they can be dropped here. */
  const acceptable = (event: DragEvent) => {
    const drag = draggedSongs(event);
    return drag && (accepts?.(drag) ?? true) ? drag : null;
  };
  const accept = (event: DragEvent) => {
    if (!acceptable(event)) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    return true;
  };

  return {
    over,
    props: disabled
      ? {}
      : {
          onDragEnter: (event: DragEvent) => {
            if (accept(event)) setOver(true);
          },
          onDragOver: accept,
          onDragLeave: (event: DragEvent) => {
            // Moving onto something inside the element is still over it.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
          },
          onDrop: (event: DragEvent) => {
            const drag = acceptable(event);
            setOver(false);
            if (!drag) return;
            event.preventDefault();
            onDrop(drag);
          },
        },
  };
}
