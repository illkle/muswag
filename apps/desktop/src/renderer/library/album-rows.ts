import type { AlbumSort, LibraryAlbum as Album } from "@muswag/model";
import { useMemo } from "react";

import { LibraryActions } from "#/library/actions";
import type { PagedWindowSource } from "#/library/paged-window";
import { onTableChange } from "#/data/library-changes";
import { usePagedWindow } from "#/library/use-paged-window";

/** The albums of the library as a grid holds them: how many there are, those read, and which it draws. */
export type AlbumRows = {
  readonly count: number;
  /** The album at `position`, or `undefined` while it loads. */
  at(position: number): Album | undefined;
  /** The positions the grid draws, from `start` up to `end`. */
  show(start: number, end: number): void;
};

/** Main reads the albums page by page in `sort` order. There are far fewer albums than songs, so every page is asked for by its offset. */
const sourceFor = (sort: AlbumSort): PagedWindowSource<Album> => ({
  page: (request, withTotal) => ("offset" in request ? LibraryActions.albumPage(sort, request, withTotal).then(({ albums, total }) => ({ rows: albums, total })) : Promise.resolve(null)),
  byNeighbour: false,
  subscribe: onTableChange("albums"),
});

/**
 * Every album of the library in `sort` order, read from main as the grid shows them: `albums` is
 * `undefined` until main has said how many there are, and `isError` while the last page asked for
 * could not be read.
 */
export function useAlbumRows(sort: AlbumSort): { albums: AlbumRows | undefined; isError: boolean } {
  const source = useMemo(() => sourceFor(sort), [sort]);
  const { window, view } = usePagedWindow(source);
  const albums = useMemo((): AlbumRows | undefined => {
    if (!window || view?.total === undefined) return undefined;
    return { count: view.total, at: (position) => window.at(position), show: (start, end) => window.show(start, end) };
  }, [window, view]);
  return { albums, isError: view?.failed ?? false };
}
