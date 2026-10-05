import type { LibrarySort, PlaylistRecord, QueueSourceRef, Song } from "@muswag/model";
import { albumOccurrenceKey, libraryOccurrenceKey, playlistOccurrenceKey } from "@muswag/model";
import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";

import type { SourceRevision } from "#shared/queue-state";
import type { QueueSource, QueueSourceFactory, SourceLocation, SourcePage } from "./types";

/** What queue sources read from the library database. */
export interface SourceDb {
  playlist(playlistId: string): Promise<PlaylistRecord | undefined>;
  songsByIds(ids: readonly string[]): Promise<Song[]>;
  /** The album's songs in playback order. */
  albumSongs(albumId: string): Promise<Song[]>;
  /** How many songs the library has. */
  librarySize(): Promise<number>;
  /** The songs at `start` up to `end` of the library in the given order, and the size of the library they were read from. */
  librarySongs(sort: LibrarySort, start: number, end: number): Promise<{ size: number; songs: Song[] }>;
  /** Where a song is in the library in the given order, or `null` when it is not in the library. */
  libraryOffset(sort: LibrarySort, songId: string): Promise<{ size: number; offset: number | null }>;
  /** Committed library changes, as the mirror server broadcasts them. */
  subscribe(listener: (batch: MirrorChangeBatch) => void): () => void;
}

const changesTo = (batch: MirrorChangeBatch, table: string) => batch.changes.filter((change) => change.table === table);

/** A short, stable digest of a source's contents. Pages read from different contents get different revisions. */
function digest(value: unknown): SourceRevision {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Re-reads a signature of the source whenever `relevant` changes arrive and reports the source's
 * revision when the signature moved. Checks run one at a time, so their results cannot arrive out of
 * order; a failed check is logged and the next relevant change checks again.
 */
function watchSignature(
  db: SourceDb,
  options: { relevant: (batch: MirrorChangeBatch) => boolean; read: () => Promise<{ signature: string; revision: SourceRevision }>; onChange: (revision: SourceRevision) => void },
): () => void {
  let disposed = false;
  let known: string | null = null;
  const check = async (notify: boolean) => {
    const { signature, revision } = await options.read();
    if (disposed) return;
    const changed = known !== null && signature !== known;
    known = signature;
    if (notify && changed) options.onChange(revision);
  };
  let checks = check(false).catch((cause: unknown) => console.error("[queue] failed to read a source", cause));
  const unsubscribe = db.subscribe((batch) => {
    if (disposed || !options.relevant(batch)) return;
    checks = checks.then(() => check(true)).catch((cause: unknown) => console.error("[queue] failed to check a source for changes", cause));
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

const entriesOf = (record: PlaylistRecord | undefined) => record?.local?.entries ?? [];
const playlistRevision = (record: PlaylistRecord | undefined) => digest(record?.local ? entriesOf(record).map(({ id, songId }) => [id, songId]) : null);
const albumRevision = (songs: readonly Song[]) => digest(songs.map(({ id }) => id));

export class PlaylistSource implements QueueSource {
  readonly ref: Extract<QueueSourceRef, { type: "playlist" }>;
  private readonly db: SourceDb;

  constructor(options: { playlistId: string; db: SourceDb }) {
    this.db = options.db;
    this.ref = { type: "playlist", playlistId: options.playlistId };
  }

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    validateRange(start, end);
    signal.throwIfAborted();
    const record = await this.db.playlist(this.ref.playlistId);
    signal.throwIfAborted();
    const entries = record?.local?.entries ?? [];
    const raw = entries.slice(start, end);
    const songs = await this.db.songsByIds([...new Set(raw.map(({ songId }) => songId))]);
    signal.throwIfAborted();
    const byId = new Map(songs.map((song) => [song.id, song]));
    const { playlistId } = this.ref;
    return {
      revision: playlistRevision(record),
      items: raw.flatMap((entry, index) => {
        const track = byId.get(entry.songId);
        return track ? [{ key: playlistOccurrenceKey(playlistId, entry.id), offset: start + index, track }] : [];
      }),
      nextOffset: Math.max(start, Math.min(end, entries.length)),
      isEnd: end >= entries.length,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }): Promise<SourceLocation | null> {
    signal.throwIfAborted();
    const record = await this.db.playlist(this.ref.playlistId);
    signal.throwIfAborted();
    const prefix = playlistOccurrenceKey(this.ref.playlistId, "");
    if (!key.startsWith(prefix)) return null;
    const entryId = key.slice(prefix.length);
    const offset = record?.local?.entries.findIndex(({ id }) => id === entryId) ?? -1;
    return offset < 0 ? null : { offset, revision: playlistRevision(record) };
  }

  /** Reports a change when the entries change or one of their songs appears or disappears. */
  subscribe(listener: (revision: SourceRevision) => void): () => void {
    const { playlistId } = this.ref;
    let songIds = new Set<string>();
    return watchSignature(this.db, {
      relevant: (batch) => changesTo(batch, "playlists").some(({ key }) => key === playlistId) || changesTo(batch, "songs").some(({ key }) => songIds.has(String(key))),
      read: async () => {
        const record = await this.db.playlist(playlistId);
        const entries = entriesOf(record);
        songIds = new Set(entries.map(({ songId }) => songId));
        const present = new Set((await this.db.songsByIds([...songIds])).map(({ id }) => id));
        return { signature: JSON.stringify(entries.map(({ id, songId }) => [id, songId, present.has(songId)])), revision: playlistRevision(record) };
      },
      onChange: listener,
    });
  }
}

export class AlbumSource implements QueueSource {
  readonly ref: Extract<QueueSourceRef, { type: "album" }>;
  private readonly db: SourceDb;

  constructor(options: { albumId: string; db: SourceDb }) {
    this.db = options.db;
    this.ref = { type: "album", albumId: options.albumId };
  }

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    validateRange(start, end);
    const songs = await this.songs(signal);
    return {
      revision: albumRevision(songs),
      items: songs.slice(start, end).map((track, index) => ({ key: albumOccurrenceKey(this.ref.albumId, track.id), offset: start + index, track })),
      nextOffset: Math.max(start, Math.min(end, songs.length)),
      isEnd: end >= songs.length,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }): Promise<SourceLocation | null> {
    const songs = await this.songs(signal);
    const offset = songs.findIndex((song) => albumOccurrenceKey(this.ref.albumId, song.id) === key);
    return offset < 0 ? null : { offset, revision: albumRevision(songs) };
  }

  /** Reports a change when songs join, leave or move within the album. */
  subscribe(listener: (revision: SourceRevision) => void): () => void {
    const { albumId } = this.ref;
    let songIds = new Set<string>();
    return watchSignature(this.db, {
      relevant: (batch) => changesTo(batch, "songs").some((change) => songIds.has(String(change.key)) || (change.type === "upsert" && change.value.albumId === albumId)),
      read: async () => {
        const songs = await this.db.albumSongs(albumId);
        songIds = new Set(songs.map(({ id }) => id));
        return { signature: albumRevision(songs), revision: albumRevision(songs) };
      },
      onChange: listener,
    });
  }

  private async songs(signal: AbortSignal): Promise<Song[]> {
    signal.throwIfAborted();
    const songs = await this.db.albumSongs(this.ref.albumId);
    signal.throwIfAborted();
    return songs;
  }
}

/**
 * Every song of the library in one of its orders. Unlike an album, the library is too large to load
 * to read a page of it, so the database does the ordering and the paging.
 *
 * Its revision is the number of songs it has, which follows songs joining and leaving. A song that
 * only moves, by being renamed, goes unnoticed until playback next moves and locates its place anew.
 */
export class LibrarySource implements QueueSource {
  readonly ref: Extract<QueueSourceRef, { type: "library" }>;
  private readonly db: SourceDb;

  constructor(options: { sort: LibrarySort; db: SourceDb }) {
    this.db = options.db;
    this.ref = { type: "library", sort: options.sort };
  }

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    validateRange(start, end);
    signal.throwIfAborted();
    const { size, songs } = await this.db.librarySongs(this.ref.sort, start, end);
    signal.throwIfAborted();
    return {
      revision: this.revision(size),
      items: songs.map((track, index) => ({ key: libraryOccurrenceKey(track.id), offset: start + index, track })),
      nextOffset: Math.max(start, Math.min(end, size)),
      isEnd: end >= size,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }): Promise<SourceLocation | null> {
    signal.throwIfAborted();
    const prefix = libraryOccurrenceKey("");
    if (!key.startsWith(prefix)) return null;
    const { size, offset } = await this.db.libraryOffset(this.ref.sort, key.slice(prefix.length));
    signal.throwIfAborted();
    return offset === null ? null : { offset, revision: this.revision(size) };
  }

  /** Reports a change when songs join or leave the library. */
  subscribe(listener: (revision: SourceRevision) => void): () => void {
    return watchSignature(this.db, {
      relevant: (batch) => changesTo(batch, "songs").length > 0,
      read: async () => {
        const revision = this.revision(await this.db.librarySize());
        return { signature: revision, revision };
      },
      onChange: listener,
    });
  }

  private revision(size: number): SourceRevision {
    return `${this.ref.sort}:${size}`;
  }
}

export function createQueueSourceFactory(db: SourceDb): QueueSourceFactory {
  return {
    open(ref) {
      switch (ref.type) {
        case "playlist":
          return new PlaylistSource({ db, playlistId: ref.playlistId });
        case "album":
          return new AlbumSource({ albumId: ref.albumId, db });
        case "library":
          return new LibrarySource({ sort: ref.sort, db });
      }
    },
  };
}

function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error(`Invalid source range [${start}, ${end}).`);
}
