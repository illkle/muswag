import { IDLE_LIBRARY_SYNC, type LibrarySort, type LibrarySyncStatus } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";

import { db } from "#/data/library";
import { appState } from "#/data/state";
import { songsInOrder } from "#/library/library-order";

/** The library sync main is running, whoever started it. */
export const useLibrarySyncStatus = (): LibrarySyncStatus => useLiveQuery((q) => q.from({ status: appState.librarySync }).findOne()).data?.value ?? IDLE_LIBRARY_SYNC;

/** The library in each of its orders. Nothing is read or sorted until a page uses one. */
export const LIBRARY_SONGS = {
  title: songsInOrder(db.songs, "title"),
} satisfies Record<LibrarySort, unknown>;
