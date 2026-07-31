import type { Song } from "@muswag/shared";
import type { PlayerQueueContext } from "#shared/player";

/** One playlist entry with its library song, or `null` when the song is not in the local library. */
export type PlaylistRow = {
  entryId: string;
  songId: string;
  song: Song | null;
};

/**
 * Builds the player queue from the rows that actually resolved. Unavailable entries are skipped,
 * so a row's queue index is not its index in the playlist and has to be looked up.
 */
export function buildPlayQueue(rows: readonly PlaylistRow[]): { queue: Song[]; queueIndexByEntryId: Map<string, number> } {
  const queue: Song[] = [];
  const queueIndexByEntryId = new Map<string, number>();

  for (const row of rows) {
    if (!row.song) continue;
    queueIndexByEntryId.set(row.entryId, queue.length);
    queue.push(row.song);
  }

  return { queue, queueIndexByEntryId };
}

export function totalDuration(rows: readonly PlaylistRow[]): number {
  return rows.reduce((total, { song }) => total + (song?.duration ?? 0), 0);
}

export function currentPlaylistEntryId(context: PlayerQueueContext, playlistId: string, currentIndex: number): string | null {
  if (context?.type !== "playlist" || context.playlistId !== playlistId || currentIndex < 0) return null;
  return context.entryIds[currentIndex] ?? null;
}
