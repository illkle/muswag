import type { QueueSourceRef, SourceWindow } from "@muswag/model";
import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";

/** How many occurrences main keeps loaded behind and ahead of the cursor. */
const SOURCE_SIZE = { behind: 10, ahead: 30 };

/** Where a window is read around: the occurrence `key` where the source has it, and otherwise the gap at `offset`. */
export type SourceAnchor = { key: string | null; offset: number | null };

/** What queue sources read from the library database. */
export interface SourceDb {
  sourceWindow(ref: QueueSourceRef, at: SourceAnchor, size: { behind: number; ahead: number }): Promise<SourceWindow | null>;
  /** Committed library changes, as the mirror server broadcasts them. */
  subscribe(listener: (batch: MirrorChangeBatch) => void): () => void;
}

/** The albums, playlists and library orders the queue plays from. */
export interface QueueSources {
  /** The part of `ref` around `at`, or `null` when the source has neither the occurrence nor an offset to fall back to. */
  window(ref: QueueSourceRef, at: SourceAnchor): Promise<SourceWindow | null>;
  /** Calls `listener` after every change to the library, with whether the change may have altered what a source holds. */
  subscribe(listener: (affects: (ref: QueueSourceRef) => boolean) => void): () => void;
}

export function createQueueSources(db: SourceDb): QueueSources {
  return {
    window: (ref, at) => db.sourceWindow(ref, at, SOURCE_SIZE),
    subscribe: (listener) =>
      db.subscribe((batch) => {
        // Every source is made of songs: one joining or leaving moves the others, and a playlist plays only those the library has.
        const songs = batch.changes.some((change) => change.table === "songs");
        const playlists = new Set(batch.changes.filter((change) => change.table === "playlists").map((change) => String(change.key)));
        if (songs || playlists.size > 0) listener((ref) => songs || (ref.type === "playlist" && playlists.has(ref.playlistId)));
      }),
  };
}
