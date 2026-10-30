import type { LibraryChange, SongIdList } from "@muswag/backend";
import type { QueueSourceRef, SourceWindow } from "@muswag/model";

/** How many occurrences main keeps loaded behind and ahead of the cursor. */
const SOURCE_SIZE = { behind: 10, ahead: 30 };

/** Where a window is read around: the occurrence `key` where the source has it, and otherwise the gap at `offset`. */
export type SourceAnchor = { key: string | null; offset: number | null };

/** What queue sources read from the library database. */
export interface SourceDb {
  sourceWindow(ref: QueueSourceRef, at: SourceAnchor, size: { behind: number; ahead: number }, songIds?: SongIdList): Promise<SourceWindow | null>;
  /** Every song id of the library, which a shuffled library is read through. */
  songIds(): Promise<SongIdList>;
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
  /** The ids of the songs, read the first time a shuffled library needs them and kept until a sync adds or removes songs. */
  let songIds: Promise<SongIdList> | null = null;
  /** The same ids once they are read, to tell a song that was only edited from a new one. */
  let known: SongIdList | null = null;
  const currentSongIds = () => {
    if (songIds) return songIds;
    const reading = db.songIds();
    songIds = reading;
    reading.then(
      (list) => {
        if (songIds === reading) known = list;
      },
      () => {
        if (songIds === reading) songIds = null;
      },
    );
    return reading;
  };

  return {
    window: async (ref, at) => db.sourceWindow(ref, at, SOURCE_SIZE, ref.type === "library" && ref.shuffle ? await currentSongIds() : undefined),
    subscribe: (listener) =>
      db.subscribe((changes) => {
        const written = changes.filter((change) => change.table === "songs");
        if (written.some(({ type, key }) => type === "deleted" || !known || known.indexOf(String(key)) < 0)) {
          songIds = null;
          known = null;
        }
        // Every source is made of songs: one joining or leaving moves the others, and a playlist plays only those the library has.
        // An artist's songs are those of its albums, in the order of their years.
        const songs = written.length > 0;
        const albums = changes.some((change) => change.table === "albums");
        const playlists = new Set(changes.filter((change) => change.table === "playlists").map((change) => String(change.key)));
        if (songs || albums || playlists.size > 0) listener((ref) => songs || (ref.type === "artist" && albums) || (ref.type === "playlist" && playlists.has(ref.playlistId)));
      }),
  };
}
