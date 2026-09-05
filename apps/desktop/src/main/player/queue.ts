import { Effect } from "effect";
import type { PlaybackItem } from "@muswag/shared";
import type { Selection } from "#shared/player-contract";
import { playerError, type EngineError, type PlayerError } from "./errors";
import { command, load, playlist } from "./mpv/protocol";
import type { SessionHandle } from "./mpv/session";

export type Entry = PlaybackItem & { readonly entryId: number };
export type Correlation = { readonly generation: number; readonly entries: readonly Entry[]; readonly currentId: number | null };
export const validateQueue = (items: readonly PlaybackItem[], select: Selection | null): Effect.Effect<void, PlayerError> =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    for (const item of items) {
      if (
        !item.key ||
        keys.has(item.key) ||
        !item.track ||
        typeof item.track !== "object" ||
        typeof item.track.id !== "string" ||
        !item.track.id ||
        typeof item.track.title !== "string" ||
        typeof item.track.isDir !== "boolean"
      )
        return yield* playerError("InvalidCommand", "queue", "Queue entries must have unique keys and valid track metadata.");
      keys.add(item.key);
    }
    if (select && !keys.has(select.key)) return yield* playerError("InvalidCommand", "queue", "Selected occurrence is not in the queue.");
  });
export const applyQueue = (
  session: SessionHandle,
  current: Correlation | null,
  items: readonly PlaybackItem[],
  select: Selection | null,
  urls: ReadonlyMap<string, string>,
): Effect.Effect<Correlation, EngineError | PlayerError> =>
  Effect.gen(function* () {
    yield* validateQueue(items, select);
    if (!items.length) {
      yield* session.execute(command("stop"));
      yield* session.execute(command("playlist-clear"));
      return { generation: session.generation, entries: [], currentId: null };
    }
    const oldCurrent = current?.entries.find((entry) => entry.entryId === current.currentId);
    const anchor = select?.key ?? oldCurrent?.key;
    if (!anchor || !items.some((item) => item.key === anchor)) return yield* playerError("InvalidCommand", "queue", "An explicit selection is required to replace the current track.");
    const same =
      current?.generation === session.generation &&
      current.entries.length === items.length &&
      current.entries.every((entry, index) => entry.key === items[index]?.key && entry.track.id === items[index]?.track.id);
    let entries: Entry[];
    if (same) {
      entries = items.map((item, index) => ({ ...item, entryId: current.entries[index]!.entryId }));
      if (select)
        yield* session.execute(
          command(
            "playlist-play-index",
            items.findIndex((item) => item.key === select.key),
          ),
        );
    } else {
      const preserve = !select && oldCurrent && items.some((item) => item.key === oldCurrent.key && item.track.id === oldCurrent.track.id);
      const anchorIndex = items.findIndex((item) => item.key === anchor);
      const anchorId = preserve ? oldCurrent.entryId : (yield* session.execute(load(urls.get(anchor)!, "replace"))).playlist_entry_id;
      if (preserve) yield* session.execute(command("playlist-clear"));
      entries = [];
      for (const [index, item] of items.entries()) {
        const entryId = index === anchorIndex ? anchorId : (yield* session.execute(load(urls.get(item.key)!, "insert-at", index))).playlist_entry_id;
        entries.push({ ...item, entryId });
      }
    }
    const actual = yield* session.execute(playlist);
    if (actual.length !== entries.length || actual.some((entry, index) => entry.id !== entries[index]?.entryId) || new Set(entries.map((entry) => entry.entryId)).size !== entries.length)
      return yield* playerError("QueueOutOfSync", "queue", "The engine playlist changed while applying the queue.");
    const currentId = actual.find((entry) => entry.current)?.id ?? null;
    const expectedId = entries.find((entry) => entry.key === anchor)?.entryId;
    if (currentId !== expectedId && (currentId !== null || !select)) return yield* playerError("QueueOutOfSync", "queue", "Playback advanced while applying the queue. Select the track again.");
    return { generation: session.generation, entries, currentId };
  });
