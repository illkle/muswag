import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

/**
 * Songs the queue started and the player could not play, by song id, until they play or the queue is
 * cleared. Lists mark them, so that what was skipped can still be told once playback has moved on.
 */
export const UnplayableTrack = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Whether the queue moved on from it by itself. Where it stayed, the player's error says so. */
  skipped: Schema.Boolean,
  /** When it failed, in milliseconds. */
  at: Schema.Finite,
});
export type UnplayableTrack = typeof UnplayableTrack.Type;

export const unplayableTracks = memoryTable("unplayable_tracks", UnplayableTrack, { primaryKey: "id" });
