import { libraryOccurrenceKey, type LibrarySong, type LibrarySort } from "@muswag/model";
import { useMemo } from "react";

import type { TrackItem, TrackRows } from "#/components/track-list/types";
import { LibraryActions } from "#/library/actions";
import type { PagedWindowSource } from "#/library/paged-window";
import { onTableChange, usePagedWindow } from "#/library/use-paged-window";

/** Main reads the pages of the songs in `sort` order, and finds the songs around one by its id. */
const sourceFor = (sort: LibrarySort): PagedWindowSource<LibrarySong> => ({
  page: (request, withTotal) => LibraryActions.songPage(sort, request, withTotal).then((page) => page && { rows: page.songs, total: page.total }),
  byNeighbour: true,
  subscribe: onTableChange("songs"),
});

// One item for each song read, so that a row whose song is the same is not drawn again.
const items = new WeakMap<LibrarySong, TrackItem>();
const itemOf = (song: LibrarySong): TrackItem => {
  let item = items.get(song);
  if (!item) items.set(song, (item = { type: "track", key: libraryOccurrenceKey(song.id), song }));
  return item;
};

/**
 * The songs of the library in `sort` order as rows for a track list, read from main as the list shows
 * them: `rows` is `undefined` until main has said how many there are, and `isError` while the last page
 * asked for could not be read.
 */
export function useSongRows(sort: LibrarySort): { rows: TrackRows | undefined; isError: boolean } {
  const source = useMemo(() => sourceFor(sort), [sort]);
  const { window, view } = usePagedWindow(source);

  const rows = useMemo((): TrackRows | undefined => {
    if (!window || view?.total === undefined) return undefined;
    return {
      count: view.total,
      at: (position) => {
        const song = window.at(position);
        return song ? itemOf(song) : undefined;
      },
      show: (start, end) => window.show(start, end),
      songIds: (spans) => LibraryActions.songIds(sort, spans),
    };
  }, [window, view, sort]);
  return { rows, isError: view?.failed ?? false };
}
