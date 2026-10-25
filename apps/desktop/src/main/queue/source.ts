import type { LibraryChange } from "@muswag/backend";
import type { QueueSourceRef, SourceWindow } from "@muswag/model";

/** How many occurrences main keeps loaded behind and ahead of the cursor. */
const SOURCE_SIZE = { behind: 10, ahead: 30 };

/** Where a window is read around: the occurrence `key` where the source has it, and otherwise the gap at `offset`. */
export type SourceAnchor = { key: string | null; offset: number | null };

/** What queue sources read from the library database. */
export interface SourceDb {
  sourceWindow(ref: QueueSourceRef, at: SourceAnchor, size: { behind: number; ahead: number }): Promise<SourceWindow | null>;
  /** The rows each committed write to the library changed. */
  subscribe(listener: (changes: ReadonlyArray<LibraryChange>) => void): () => void;
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
      db.subscribe((changes) => {
        // Every source is made of songs: one joining or leaving moves the others, and a playlist plays only those the library has.
        // An artist's songs are those of its albums, in the order of their years.
        const songs = changes.some((change) => change.table === "songs");
        const albums = changes.some((change) => change.table === "albums");
        const playlists = new Set(changes.filter((change) => change.table === "playlists").map((change) => String(change.key)));
        if (songs || albums || playlists.size > 0) listener((ref) => songs || (ref.type === "artist" && albums) || (ref.type === "playlist" && playlists.has(ref.playlistId)));
      }),
  };
}
