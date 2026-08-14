import { db as rendererDb } from "#/lib/db-renderer";
import type { MuswagDb, PlaylistRecord, QueueSourceRef, Song } from "#core";
import { albumOccurrenceKey, playlistOccurrenceKey } from "#core";
import { eq, inArray, queryOnce } from "@tanstack/react-db";

import type { QueueSource, QueueSourceFactory, SourceLocation, SourcePage, SourceRevision } from "./queue-source";

type SourceDb = Pick<MuswagDb, "albums" | "playlists" | "songs">;

export class PlaylistSource implements QueueSource {
  readonly ref: Extract<QueueSourceRef, { type: "playlist" }>;
  private readonly db: SourceDb;
  private generation = 0;
  private entrySignature: string | null = null;

  constructor(options: { playlistId: string; db?: SourceDb }) {
    this.db = options.db ?? rendererDb;
    this.ref = { type: "playlist", playlistId: options.playlistId };
  }

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    validateRange(start, end);
    signal.throwIfAborted();
    const record = await this.record();
    signal.throwIfAborted();
    const entries = record?.local?.entries ?? [];
    const raw = entries.slice(start, end);
    const ids = [...new Set(raw.map(({ songId }) => songId))];
    const songs = ids.length ? await queryOnce((q) => q.from({ song: this.db.songs }).where(({ song }) => inArray(song.id, ids))) : [];
    signal.throwIfAborted();
    const byId = new Map(songs.map((song) => [song.id, song]));
    const { playlistId } = this.ref;
    return {
      revision: this.revision(record),
      items: raw.flatMap((entry, index) => {
        const track = byId.get(entry.songId);
        return track ? [{ key: playlistOccurrenceKey(playlistId, entry.id), offset: start + index, track: structuredClone(track) }] : [];
      }),
      nextOffset: Math.max(start, Math.min(end, entries.length)),
      isEnd: end >= entries.length,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }): Promise<SourceLocation | null> {
    signal.throwIfAborted();
    const record = await this.record();
    signal.throwIfAborted();
    const prefix = playlistOccurrenceKey(this.ref.playlistId, "");
    if (!key.startsWith(prefix)) return null;
    const entryId = key.slice(prefix.length);
    const offset = record?.local?.entries.findIndex(({ id }) => id === entryId) ?? -1;
    return offset < 0 ? null : { offset, revision: this.revision(record) };
  }

  subscribe(listener: (revision: SourceRevision) => void): () => void {
    const { playlistId } = this.ref;
    const bump = () => {
      this.generation += 1;
      listener(this.revision(this.db.playlists.get(playlistId)));
    };
    this.entrySignature = entriesSignature(this.db.playlists.get(playlistId));
    const playlistSubscription = this.db.playlists.subscribeChanges((changes) => {
      if (!changes.some(({ key }) => key === playlistId)) return;
      const signature = entriesSignature(this.db.playlists.get(playlistId));
      if (signature === this.entrySignature) return;
      this.entrySignature = signature;
      bump();
    });
    const songSubscription = this.db.songs.subscribeChanges((changes) => {
      const songIds = new Set((this.db.playlists.get(playlistId)?.local?.entries ?? []).map(({ songId }) => songId));
      if (changes.some((change) => typeof change.key === "string" && songIds.has(change.key) && change.type !== "update")) bump();
    });
    return () => {
      playlistSubscription.unsubscribe();
      songSubscription.unsubscribe();
    };
  }

  private record(): Promise<PlaylistRecord | undefined> {
    return queryOnce((q) =>
      q
        .from({ playlist: this.db.playlists })
        .where(({ playlist }) => eq(playlist.id, this.ref.playlistId))
        .findOne(),
    );
  }

  private revision(record: PlaylistRecord | undefined): SourceRevision {
    return `${record?.revision ?? "missing"}:${this.generation}`;
  }
}

export class AlbumSource implements QueueSource {
  readonly ref: Extract<QueueSourceRef, { type: "album" }>;
  private readonly db: SourceDb;
  private generation = 0;

  constructor(options: { albumId: string; db?: SourceDb }) {
    this.db = options.db ?? rendererDb;
    this.ref = { type: "album", albumId: options.albumId };
  }

  async read({ start, end, signal }: { start: number; end: number; signal: AbortSignal }): Promise<SourcePage> {
    validateRange(start, end);
    const songs = await this.songs(signal);
    return {
      revision: this.revision,
      items: songs.slice(start, end).map((track, index) => ({ key: albumOccurrenceKey(this.ref.albumId, track.id), offset: start + index, track: structuredClone(track) })),
      nextOffset: Math.max(start, Math.min(end, songs.length)),
      isEnd: end >= songs.length,
    };
  }

  async locate({ key, signal }: { key: string; signal: AbortSignal }): Promise<SourceLocation | null> {
    const songs = await this.songs(signal);
    const offset = songs.findIndex((song) => albumOccurrenceKey(this.ref.albumId, song.id) === key);
    return offset < 0 ? null : { offset, revision: this.revision };
  }

  subscribe(listener: (revision: SourceRevision) => void): () => void {
    const subscription = this.db.songs.subscribeChanges((changes) => {
      const relevant = changes.some((change) => {
        const before = change.previousValue as Song | undefined;
        const after = change.value as Song;
        if (before?.albumId !== this.ref.albumId && after.albumId !== this.ref.albumId) return false;
        return change.type !== "update" || before?.albumId !== after.albumId || before?.discNumber !== after.discNumber || before?.track !== after.track;
      });
      if (relevant) {
        this.generation += 1;
        listener(this.revision);
      }
    });
    return () => subscription.unsubscribe();
  }

  private get revision(): SourceRevision {
    return String(this.generation);
  }

  private async songs(signal: AbortSignal): Promise<Song[]> {
    signal.throwIfAborted();
    const songs = await queryOnce((q) =>
      q
        .from({ song: this.db.songs })
        .where(({ song }) => eq(song.albumId, this.ref.albumId))
        .orderBy(({ song }) => [song.discNumber, song.track, song.id]),
    );
    signal.throwIfAborted();
    return songs;
  }
}

export function createQueueSourceFactory(options: { db?: SourceDb } = {}): QueueSourceFactory {
  const db = options.db ?? rendererDb;
  return {
    open(ref) {
      switch (ref.type) {
        case "playlist":
          return new PlaylistSource({ db, playlistId: ref.playlistId });
        case "album":
          return new AlbumSource({ albumId: ref.albumId, db });
      }
    },
  };
}

function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error(`Invalid source range [${start}, ${end}).`);
}

function entriesSignature(record: PlaylistRecord | undefined): string {
  return JSON.stringify(record?.local?.entries.map(({ id, songId }) => [id, songId]) ?? null);
}
