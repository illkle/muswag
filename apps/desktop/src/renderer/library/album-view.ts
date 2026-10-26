import { AlbumSort } from "@muswag/model";
import { createStore, useSelector } from "@tanstack/react-store";
import { Schema } from "effect";

const STORAGE_KEY = "muswag-album-view";

/** The sizes of the albums page's covers, by the narrowest a tile gets at each, which sets how many columns there are. */
export const TILE_SIZES = { s: 130, m: 180, l: 240, xl: 300 } as const;
export type TileSize = keyof typeof TILE_SIZES;
const isTileSize = (value: unknown): value is TileSize => typeof value === "string" && Object.hasOwn(TILE_SIZES, value);

/** How the albums page shows the albums: in which order, and how large. A preference of this window, so it stays in the renderer. */
export type AlbumView = { sort: AlbumSort; tileSize: TileSize };

const isSort = Schema.is(AlbumSort);

function stored(): AlbumView {
  const view: AlbumView = { sort: "year-desc", tileSize: "m" };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return view;
    if ("sort" in saved && isSort(saved.sort)) view.sort = saved.sort;
    if ("tileSize" in saved && isTileSize(saved.tileSize)) view.tileSize = saved.tileSize;
  } catch {
    // Left as it is by default.
  }
  return view;
}

const albumView = createStore(stored());

export const useAlbumView = () => useSelector(albumView, (view) => view);

export function setAlbumView(change: Partial<AlbumView>) {
  albumView.setState((view) => ({ ...view, ...change }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(albumView.state));
}
