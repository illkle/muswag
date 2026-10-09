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

export const QueueSourceRef = Schema.Union([
  Schema.Struct({ type: Schema.Literal("playlist"), playlistId: Id }),
  Schema.Struct({ type: Schema.Literal("album"), albumId: Id }),
  /** Every song of the library, in the given order. */
  Schema.Struct({ type: Schema.Literal("library"), sort: LibrarySort }),
]);
export type QueueSourceRef = typeof QueueSourceRef.Type;

export function playlistOccurrenceKey(playlistId: string, entryId: string): string {
  return `playlist:${playlistId}:${entryId}`;
}

export function albumOccurrenceKey(albumId: string, songId: string): string {
  return `album:${albumId}:${songId}`;
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
