import { Effect, type Redacted } from "effect";
import type { PlaybackItem } from "@muswag/shared";
import type { Selection } from "#shared/player-contract";
import { InvalidCommand, QueueOutOfSync, type EngineError } from "./errors";
import { command, load, playlist } from "./mpv/protocol";
import type { SessionHandle } from "./mpv/session";

export type Entry = PlaybackItem & { readonly entryId: number };
/** Which mpv playlist entry holds each queue occurrence, for one session generation. */
export type Correlation = { readonly generation: number; readonly entries: readonly Entry[]; readonly currentId: number | null };

const sameOccurrence = (a: PlaybackItem, b: PlaybackItem) => a.key === b.key && a.track.id === b.track.id;
export const currentEntry = (correlation: Correlation | null): Entry | undefined => correlation?.entries.find((entry) => entry.entryId === correlation.currentId);
/** Whether `items` still contains the occurrence mpv is currently playing, so it can be edited without a new selection. */
export const retainsCurrent = (correlation: Correlation, items: readonly PlaybackItem[]): boolean => {
  const current = currentEntry(correlation);
  return current !== undefined && items.some((item) => sameOccurrence(item, current));
};

/**
 * Mirrors a validated, non-empty queue into mpv's playlist and returns the resulting correlation.
 * Without a selection the current occurrence must be retained (see `retainsCurrent`) and keeps playing.
 * Fails with QueueOutOfSync if mpv's playlist does not end up exactly as expected.
 */
export const applyQueue = Effect.fn("applyQueue")(function* (
  session: SessionHandle,
  current: Correlation | null,
  items: readonly PlaybackItem[],
  select: Selection | null,
  urls: ReadonlyMap<string, Redacted.Redacted<string>>,
): Effect.fn.Return<Correlation, EngineError | InvalidCommand | QueueOutOfSync> {
  const previous = currentEntry(current);
  const anchorKey = select?.key ?? previous?.key;
  const anchorIndex = items.findIndex((item) => item.key === anchorKey);
  if (anchorIndex < 0) return yield* new InvalidCommand({ operation: "queue", message: "An explicit selection is required to replace the current track." });
  const urlAt = (index: number) => urls.get(items[index]!.key)!;

  let entryIds: number[];
  const unchanged = current?.generation === session.generation && current.entries.length === items.length && current.entries.every((entry, index) => sameOccurrence(entry, items[index]!));
  if (unchanged) {
    entryIds = current.entries.map((entry) => entry.entryId);
    if (select) yield* session.execute(command("playlist-play-index", anchorIndex));
  } else {
    // Keep the playing entry untouched when the edit retains it; otherwise replace everything, starting at the anchor.
    const keep = !select && previous !== undefined && items.some((item) => sameOccurrence(item, previous));
    const anchorId = keep ? previous.entryId : (yield* session.execute(load(urlAt(anchorIndex), "replace"))).playlist_entry_id;
    if (keep) yield* session.execute(command("playlist-clear"));
    entryIds = [];
    for (let index = 0; index < items.length; index++) {
      entryIds.push(index === anchorIndex ? anchorId : (yield* session.execute(load(urlAt(index), "insert-at", index))).playlist_entry_id);
    }
  }

  const actual = yield* session.execute(playlist);
  const matches = actual.length === entryIds.length && actual.every((entry, index) => entry.id === entryIds[index]) && new Set(entryIds).size === entryIds.length;
  if (!matches) return yield* new QueueOutOfSync({ operation: "queue", message: "The engine playlist changed while applying the queue." });
  const currentId = actual.find((entry) => entry.current)?.id ?? null;
  // A fresh selection may not be marked current until mpv emits start-file.
  if (currentId !== entryIds[anchorIndex] && !(select && currentId === null))
    return yield* new QueueOutOfSync({ operation: "queue", message: "Playback advanced while applying the queue. Select the track again." });
  return { generation: session.generation, entries: items.map((item, index) => ({ ...item, entryId: entryIds[index]! })), currentId };
});
