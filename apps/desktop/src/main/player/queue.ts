import { Effect, type Redacted } from "effect";
import type { PlaybackItem } from "@muswag/model";
import type { Selection } from "#shared/commands/player";
import { InvalidCommand, QueueOutOfSync, type EngineError } from "./errors";
import { command, load, playlist } from "./mpv/protocol";
import type { SessionHandle } from "./mpv/session";

export type Entry = PlaybackItem & { readonly entryId: number };
/** Which mpv playlist entry holds each queue occurrence, for one session generation. */
export type Correlation = { readonly generation: number; readonly entries: readonly Entry[]; readonly currentId: number | null };

const sameOccurrence = (a: PlaybackItem, b: PlaybackItem) => a.key === b.key && a.track.id === b.track.id;
export const currentEntry = (correlation: Correlation | null): Entry | undefined => correlation?.entries.find((entry) => entry.entryId === correlation.currentId);
/** Whether `items` still contains the occurrence mpv is currently on, so it can be edited without a new selection. */
export const retainsCurrent = (correlation: Correlation, items: readonly PlaybackItem[]): boolean => {
  const current = currentEntry(correlation);
  return current !== undefined && items.some((item) => sameOccurrence(item, current));
};

/**
 * Mirrors a validated, non-empty queue into mpv's playlist and returns the resulting correlation.
 *
 * Only the difference is sent: entries the queue keeps in the same order stay where they are, so a queue
 * that slides by one track costs one removal and one insertion, and mpv keeps what it prefetched.
 *
 * With a selection mpv starts that occurrence, in place when the playlist already holds it. Without one
 * the current occurrence must be retained (see `retainsCurrent`) and nothing about playback changes.
 * Fails with QueueOutOfSync if mpv's playlist does not end up exactly as expected.
 */
export const applyQueue = Effect.fn("applyQueue")(function* (
  session: SessionHandle,
  current: Correlation | null,
  items: readonly PlaybackItem[],
  select: Selection | null,
  urls: ReadonlyMap<string, Redacted.Redacted<string>>,
): Effect.fn.Return<Correlation, EngineError | InvalidCommand | QueueOutOfSync> {
  const live = current?.generation === session.generation ? current : null;
  const previous = currentEntry(live);
  const anchorKey = select?.key ?? previous?.key;
  const anchorIndex = items.findIndex((item) => item.key === anchorKey);
  /** mpv's playlist, kept in step with every command below. */
  let entries: Entry[] = live ? [...live.entries] : [];
  const held = anchorIndex < 0 ? undefined : entries.find((entry) => sameOccurrence(entry, items[anchorIndex]!));
  if (anchorIndex < 0 || (!select && !held)) return yield* new InvalidCommand({ operation: "queue", message: "An explicit selection is required to replace the current track." });
  const urlAt = (index: number) => urls.get(items[index]!.key)!;

  if (!held) entries = [{ ...items[anchorIndex]!, entryId: (yield* session.execute(load(urlAt(anchorIndex), "replace"))).playlist_entry_id }];
  else if (select) yield* session.execute(command("playlist-play-index", entries.indexOf(held)));
  const anchorId = (held ?? entries[0]!).entryId;

  // A reordered queue keeps only the anchor, which mpv is on and must not lose.
  const indexIn = new Map(items.map((item, index) => [item.key, index]));
  const position = (entry: Entry) => {
    const index = indexIn.get(entry.key);
    return index !== undefined && sameOccurrence(entry, items[index]!) ? index : -1;
  };
  const common = entries.filter((entry) => position(entry) >= 0);
  const inOrder = common.every((entry, index) => index === 0 || position(common[index - 1]!) < position(entry));
  const kept = new Set(inOrder ? common.map((entry) => entry.entryId) : [anchorId]);
  for (let index = entries.length - 1; index >= 0; index--) {
    if (kept.has(entries[index]!.entryId)) continue;
    yield* session.execute(command("playlist-remove", index));
    entries.splice(index, 1);
  }
  for (const [index, item] of items.entries()) {
    const entry = entries[index];
    if (entry && sameOccurrence(entry, item)) continue;
    entries.splice(index, 0, { ...item, entryId: (yield* session.execute(load(urlAt(index), "insert-at", index))).playlist_entry_id });
  }

  const actual = yield* session.execute(playlist);
  const matches = actual.length === entries.length && actual.every((entry, index) => entry.id === entries[index]!.entryId) && new Set(actual.map((entry) => entry.id)).size === actual.length;
  if (!matches) return yield* new QueueOutOfSync({ operation: "queue", message: "The engine playlist changed while applying the queue." });
  // A fresh selection may not be marked current until mpv emits start-file. An edit does not decide which
  // entry is current at all: mpv may have advanced meanwhile, and says so with start-file.
  const currentId = actual.find((entry) => entry.current)?.id ?? null;
  if (select && currentId !== null && currentId !== anchorId) return yield* new QueueOutOfSync({ operation: "queue", message: "The engine did not start the selected track." });
  return { generation: session.generation, entries: items.map((item, index) => ({ ...item, entryId: entries[index]!.entryId })), currentId: anchorId };
});
