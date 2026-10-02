import { z } from "zod";

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

export type QueueSourceRef = { type: "playlist"; playlistId: string } | { type: "album"; albumId: string };

/** What the queue restores from after a restart. */
export type QueueManagerSnapshot = {
  nowPlaying: NowPlaying | null;
  userQueue: PlaybackItem[];
  source: { ref: QueueSourceRef; cursor: SourceCursor } | null;
  /** Where to resume. Restores always start paused, so play state is not persisted. */
  playback: {
    positionSeconds: number;
  };
};

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

const occurrenceKey = z.string().min(1);
const offset = z.number().int().nonnegative();

/** Only the fields playback relies on are validated; the rest of the stored track is carried through. */
const trackSchema = z.looseObject({ id: z.string(), title: z.string(), isDir: z.boolean() }).transform((track) => structuredClone(track) as Song);
const playbackItemSchema = z.object({ key: occurrenceKey, track: trackSchema });

const snapshotSchema = z.object({
  nowPlaying: playbackItemSchema.extend({ origin: z.enum(["source", "user"]) }).nullable(),
  // A malformed user occurrence is recoverable and must not discard the rest of the record.
  userQueue: z.array(z.unknown()).transform((items) => items.flatMap((item) => playbackItemSchema.safeParse(item).data ?? [])),
  source: z
    .object({
      ref: z.discriminatedUnion("type", [z.object({ type: z.literal("playlist"), playlistId: z.string() }), z.object({ type: z.literal("album"), albumId: z.string() })]),
      cursor: z.discriminatedUnion("type", [z.object({ type: z.literal("item"), key: occurrenceKey, offset }), z.object({ type: z.literal("gap"), offset })]),
    })
    .nullable(),
  playback: z.object({ positionSeconds: z.number().nonnegative() }),
});

/** Defensive validation for the queue as read back from the database. */
export function parseQueueManagerSnapshot(value: unknown): QueueManagerSnapshot | null {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  // The queue only holds an occurrence once, and the one playing is no longer queued.
  const seen = new Set(parsed.data.nowPlaying ? [parsed.data.nowPlaying.key] : []);
  return { ...parsed.data, userQueue: parsed.data.userQueue.filter(({ key }) => !seen.has(key) && (seen.add(key), true)) };
}
