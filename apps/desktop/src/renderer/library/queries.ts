import { IDLE_LIBRARY_SYNC, type LibrarySort, type LibrarySyncStatus } from "@muswag/model";
import { useSelector } from "@tanstack/react-store";

import { db } from "#/data/library";
import { appState } from "#/data/state";
import { rowStore } from "#/data/stores";
import { songsInOrder } from "#/library/library-order";

const librarySyncRow = rowStore(appState.librarySync, "library_sync");

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useSelector(librarySyncRow, (row) => row?.value ?? IDLE_LIBRARY_SYNC);

/** The library in each of its orders. Nothing is read or sorted until a page uses one. */
export const LIBRARY_SONGS = {
  title: songsInOrder(db.songs, "title"),
} satisfies Record<LibrarySort, unknown>;
