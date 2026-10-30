import { Schema } from "effect";

import { Id } from "./contract.js";
import type { Song } from "./db/schema.js";
import { LibrarySort } from "./library-order.js";

/** A single playback occurrence. Keys, unlike song ids, are unique in a queue. */
export type PlaybackItem = {
  key: string;
  track: Song;
};

export type NowPlaying = PlaybackItem & {
  origin: "source" | "user";
};

/** Where playback is in a source: on an occurrence, or where one was before it left the source. */
export type SourceCursor = { type: "item"; key: string; offset: number } | { type: "gap"; offset: number };

export type SourceItem = PlaybackItem & {
  /** The occurrence's position in its source, counting those that cannot be played. */
  offset: number;
};

/** The part of a queue source main keeps loaded around the cursor. */
export type SourceWindow = {
  cursor: SourceCursor;
  previous: readonly SourceItem[];
  current: SourceItem | null;
  next: readonly SourceItem[];
  /** Whether the source goes on past `next`. Main loads what follows as the cursor advances. */
  hasMore: boolean;
};

/**
 * A source played in a random order instead of its own. `seed` decides the order, so main can read it
 * again from anywhere and nothing of it is stored. `first` is the occurrence it starts from: the one
 * playing when shuffle was turned on, so that nothing that never played comes before it.
 */
export const SourceShuffle = Schema.Struct({ seed: Schema.Finite, first: Schema.NullOr(Id) });
export type SourceShuffle = typeof SourceShuffle.Type;

const shuffle = { shuffle: Schema.optionalKey(SourceShuffle) };

export const QueueSourceRef = Schema.Union([
  Schema.Struct({ type: Schema.Literal("playlist"), playlistId: Id, ...shuffle }),
  Schema.Struct({ type: Schema.Literal("album"), albumId: Id, ...shuffle }),
  /** Every album of an artist, one after another in `ARTIST_ALBUM_ORDER`, then its songs on the albums of others (`Discography`). */
  Schema.Struct({ type: Schema.Literal("artist"), artistId: Id, ...shuffle }),
  /** Every song of the library, in the given order. */
  Schema.Struct({ type: Schema.Literal("library"), sort: LibrarySort, ...shuffle }),
]);
export type QueueSourceRef = typeof QueueSourceRef.Type;

/** `ref` in a new random order that starts from the occurrence `first`. */
export function shuffledSource(ref: QueueSourceRef, first: string | null): QueueSourceRef {
  return { ...ref, shuffle: { seed: crypto.getRandomValues(new Uint32Array(1))[0]!, first } };
}

/** `ref` in its own order. */
export function unshuffledSource({ shuffle: _shuffle, ...ref }: QueueSourceRef): QueueSourceRef {
  return ref;
}

export function playlistOccurrenceKey(playlistId: string, entryId: string): string {
  return `playlist:${playlistId}:${entryId}`;
}

export function albumOccurrenceKey(albumId: string, songId: string): string {
  return `album:${albumId}:${songId}`;
}

export function artistOccurrenceKey(artistId: string, songId: string): string {
  return `artist:${artistId}:${songId}`;
}

/** The same for every order of the library, so an occurrence keeps its key when the order changes. */
export function libraryOccurrenceKey(songId: string): string {
  return `library:${songId}`;
}

export function createUserPlaybackItem(track: Song): PlaybackItem {
  return { key: `user:${crypto.randomUUID()}`, track: structuredClone(track) };
}

/** Clones an occurrence without carrying subtype-specific metadata with it. */
export function clonePlaybackItem(item: PlaybackItem): PlaybackItem {
  return { key: item.key, track: structuredClone(item.track) };
}
