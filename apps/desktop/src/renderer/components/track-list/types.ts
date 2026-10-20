import type { LibrarySong } from "@muswag/model";
import type { ReactNode } from "react";

import type { Span } from "#/components/track-list/selection";

/** One occurrence of a song in a list. The same song can appear in several rows, each with its own key. */
export type TrackItem = {
  type: "track";
  /** Unique in the list: an occurrence key where the list has them, otherwise the song id. */
  key: string;
  song: LibrarySong;
  /** The list references this song but it is not in the synced local library. */
  unavailable?: boolean;
};

/** A row of a track list: a track, a heading over the tracks that follow it, a line of text, or whatever a list draws itself at a height it gives. */
export type TrackListItem =
  | TrackItem
  | { type: "heading"; key: string; title: string; subtitle?: string }
  | { type: "note"; key: string; label: string }
  | { type: "block"; key: string; height: number; content: ReactNode };

export const isTrackItem = (item: TrackListItem): item is TrackItem => item.type === "track";

/**
 * The rows of a list too long to hold, such as the songs page: how many there are, and those it has
 * loaded. The list says which rows it shows so that they load, and draws a row that has not loaded yet
 * as a placeholder. Every row is a track.
 */
export type TrackRows = {
  readonly count: number;
  /** The track at `position`, or `undefined` while it loads. */
  at(position: number): TrackItem | undefined;
  /** The positions the list draws, from `start` up to `end`. */
  show(start: number, end: number): void;
  /** The songs at the positions of `spans`, in list order, loaded or not. */
  songIds(spans: readonly Span[]): Promise<readonly string[]>;
};

/** The selected rows of a track list, in list order. This is what its menu acts on. */
export type TrackSelection = {
  /** The selected rows the list holds: every one of them, except in a list of `TrackRows`, which holds only those it has loaded. */
  items: readonly TrackItem[];
  /** How many of the selected rows have a song in the library. */
  count: number;
  /** The songs of those rows, in list order. A song selected in two rows is here twice. */
  songIds: () => Promise<readonly string[]>;
};
