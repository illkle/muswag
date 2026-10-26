import { useEffect, useState, type DragEvent } from "react";

import { creditLine } from "#/library/album-tracks";
import { formatMetaLine } from "#/lib/format";

/**
 * Songs being dragged within the window, from a track list, an album, a playlist or the player, to a
 * playlist or the queue. The browser carries only a marker of the drag; what is dragged stays here, so
 * the songs can be read when they are dropped rather than when the drag starts.
 */
export type SongDrag = {
  /** What the drag shows next to the pointer, as a search result shows its title. */
  label: string;
  /** The line under the label, such as what it is and by whom. */
  detail?: string;
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

/** The detail of a drag of one song, album or playlist, written as the search writes it. */
export const dragDetail = {
  song: (song: Parameters<typeof creditLine>[0]) => formatMetaLine(["Song", creditLine(song)]),
  album: (album: Parameters<typeof creditLine>[0]) => formatMetaLine(["Album", creditLine(album)]),
  playlist: (songCount: number) => formatMetaLine(["Playlist", `${songCount} song${songCount === 1 ? "" : "s"}`]),
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

  // The pointer carries what is dragged as a search result shows it, not as a picture of the row or tile it started on.
  const image = dragImage(drag, event.target instanceof Element ? coverOf(event.target) : null);
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

/** The cover the drag started from, when it has loaded: that of a tile, a row or the dragged image itself. */
const coverOf = (source: Element): HTMLImageElement | null => {
  const image = source instanceof HTMLImageElement ? source : source.querySelector("img");
  return image?.complete && image.naturalWidth > 0 ? image : null;
};

const COVER_SIZE = 40;

/**
 * What the pointer carries: the cover beside the label over the detail, on a raised surface, as a
 * result of the search is drawn. The browser takes its picture at once, before an image could load,
 * so the cover is drawn from the one already shown onto a canvas, cropped square as it is shown.
 */
function dragImage(drag: SongDrag, cover: HTMLImageElement | null): HTMLElement {
  const image = document.createElement("div");
  image.className = "fixed top-0 -left-[1000px] flex w-64 items-center gap-2.5 rounded-lg surface-raised p-1.5 pr-3";

  const art = document.createElement("div");
  art.className = "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted text-lg font-semibold text-muted-foreground uppercase";
  if (cover) {
    const canvas = document.createElement("canvas");
    const scale = window.devicePixelRatio;
    canvas.width = canvas.height = COVER_SIZE * scale;
    canvas.className = "size-full";
    const side = Math.min(cover.naturalWidth, cover.naturalHeight);
    canvas.getContext("2d")?.drawImage(cover, (cover.naturalWidth - side) / 2, (cover.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    art.append(canvas);
  } else {
    art.textContent = [...drag.label.trim()][0] ?? "";
  }

  const text = document.createElement("div");
  text.className = "min-w-0 flex-1";
  const label = document.createElement("div");
  label.className = "truncate text-sm";
  label.textContent = drag.label;
  text.append(label);
  if (drag.detail) {
    const detail = document.createElement("div");
    detail.className = "truncate text-xs text-muted-foreground";
    detail.textContent = drag.detail;
    text.append(detail);
  }

  image.append(art, text);
  return image;
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
