import { Schema } from "effect";

import { Id } from "./contract.js";
import type { Song } from "./db/schema.js";

/** A single playback occurrence. Keys, unlike song ids, are unique in a queue. */
export type PlaybackItem = {
  key: string;
  track: Song;
};

export type NowPlaying = PlaybackItem & {
  origin: "source" | "user";
};

export type SourceCursor = { type: "item"; key: string; offset: number } | { type: "gap"; offset: number };

export const QueueSourceRef = Schema.Union([Schema.Struct({ type: Schema.Literal("playlist"), playlistId: Id }), Schema.Struct({ type: Schema.Literal("album"), albumId: Id })]);
export type QueueSourceRef = typeof QueueSourceRef.Type;

export function playlistOccurrenceKey(playlistId: string, entryId: string): string {
  return `playlist:${playlistId}:${entryId}`;
}

export function albumOccurrenceKey(albumId: string, songId: string): string {
  return `album:${albumId}:${songId}`;
}

export function createUserPlaybackItem(track: Song): PlaybackItem {
  return { key: `user:${crypto.randomUUID()}`, track: structuredClone(track) };
}

/** Clones an occurrence without carrying subtype-specific metadata with it. */
export function clonePlaybackItem(item: PlaybackItem): PlaybackItem {
  return { key: item.key, track: structuredClone(item.track) };
}
