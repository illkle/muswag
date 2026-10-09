import type { Song } from "@muswag/model";

/** One occurrence of a song in a list. The same song can appear in several rows, each with its own key. */
export type TrackItem = {
  type: "track";
  /** Unique in the list: an occurrence key where the list has them, otherwise the song id. */
  key: string;
  song: Song;
  /** The list references this song but it is not in the synced local library. */
  unavailable?: boolean;
};

/** A row of a track list: a track, a heading over the tracks that follow it, or a line of text. */
export type TrackListItem = TrackItem | { type: "heading"; key: string; title: string; subtitle?: string } | { type: "note"; key: string; label: string };

export const isTrackItem = (item: TrackListItem): item is TrackItem => item.type === "track";

/** The selected rows of a track list, in list order. This is what its menu acts on. */
export type TrackSelection = {
  items: readonly TrackItem[];
  /** The songs of the selected rows that are in the library. A song selected in two rows is here twice. */
  songs: readonly Song[];
};
