import type { Song } from "@muswag/shared";

/** One playlist entry with its library song, or `null` when the song is not in the local library. */
export type PlaylistRow = {
  entryId: string;
  songId: string;
  song: Song | null;
};

export function totalDuration(rows: readonly PlaylistRow[]): number {
  return rows.reduce((total, { song }) => total + (song?.duration ?? 0), 0);
}
