import { it } from "@effect/vitest";
import { songRow, type PlaybackItem } from "@muswag/model";
import { Effect, Redacted } from "effect";
import { describe, expect } from "vitest";
import { applyQueue, type Correlation } from "./queue";
import type { SessionHandle } from "./mpv/session";
import { EngineError } from "./errors";

const [a, b, c, d] = ["a", "b", "c", "d"].map((key): PlaybackItem => ({ key, track: songRow({ id: key, title: key }) })) as [PlaybackItem, PlaybackItem, PlaybackItem, PlaybackItem];
const urls = new Map([a, b, c, d].map((item) => [item.key, Redacted.make(`https://secret.test/${item.key}`)]));

/** An mpv playlist holding `keys` as entries 1, 2, ... with entry `currentId` current, and the commands sent to it. */
function playlistOf(keys: readonly PlaybackItem[], currentId: number) {
  let entries = keys.map((_, index) => ({ id: index + 1, current: index + 1 === currentId }));
  let nextId = keys.length;
  const sent: unknown[][] = [];
  let failure: ((name: string) => EngineError | undefined) | undefined;
  const session: SessionHandle = {
    generation: 1,
    sequence: () => 0,
    failure: Effect.never,
    execute: (input) => {
      const [name, first, mode, index] = input.args;
      const error = failure?.(input.name);
      if (error) return Effect.fail(error);
      if (name === "get_property") return input.decode(entries);
      sent.push([
        name,
        ...(name === "loadfile"
          ? [
              Redacted.value(first as Redacted.Redacted<string>)
                .split("/")
                .at(-1),
              mode,
              index,
            ]
          : input.args.slice(1)),
      ]);
      if (name === "loadfile") {
        const entry = { id: ++nextId, current: mode === "replace" };
        if (mode === "replace") entries = [entry];
        else entries.splice(index as number, 0, entry);
        return input.decode({ playlist_entry_id: entry.id });
      }
      if (name === "playlist-remove") entries.splice(first as number, 1);
      if (name === "playlist-play-index") entries = entries.map((entry, at) => ({ ...entry, current: at === first }));
      return input.decode(undefined);
    },
  };
  const correlation: Correlation = { generation: 1, entries: keys.map((item, index) => ({ ...item, entryId: index + 1 })), currentId };
  return {
    session,
    correlation,
    sent,
    ids: () => entries.map((entry) => entry.id),
    advanceTo: (id: number) => {
      entries = entries.map((entry) => ({ ...entry, current: entry.id === id }));
    },
    failWith: (next: typeof failure) => {
      failure = next;
    },
  };
}

describe("queue commit", () => {
  it.effect("sends only what changed, leaving the entries mpv may have prefetched in place", () =>
    Effect.gen(function* () {
      const mpv = playlistOf([a, b, c], 2);
      const slid = yield* applyQueue(mpv.session, mpv.correlation, [b, c, d], null, urls);
      expect(mpv.sent).toEqual([
        ["playlist-remove", 0],
        ["loadfile", "d", "insert-at", 2],
      ]);
      expect(slid).toMatchObject({
        currentId: 2,
        entries: [
          { key: "b", entryId: 2 },
          { key: "c", entryId: 3 },
          { key: "d", entryId: 4 },
        ],
      });

      const unchanged = yield* applyQueue(mpv.session, slid, [b, c, d], null, urls);
      expect(mpv.sent).toHaveLength(2);
      expect(unchanged.entries).toEqual(slid.entries);
    }),
  );
  it.effect("starts a selected occurrence in place when the playlist holds it, and replaces the playlist when it does not", () =>
    Effect.gen(function* () {
      const mpv = playlistOf([a, b, c], 1);
      const next = yield* applyQueue(mpv.session, mpv.correlation, [a, b, c], { key: "b", play: true, positionSeconds: 0 }, urls);
      expect(mpv.sent).toEqual([["playlist-play-index", 1]]);
      expect(next.currentId).toBe(2);

      const other = yield* applyQueue(mpv.session, next, [c, d], { key: "d", play: true, positionSeconds: 0 }, urls);
      expect(mpv.sent.slice(1)).toEqual([
        ["loadfile", "d", "replace", -1],
        ["loadfile", "c", "insert-at", 0],
      ]);
      expect(other).toMatchObject({
        currentId: 4,
        entries: [
          { key: "c", entryId: 5 },
          { key: "d", entryId: 4 },
        ],
      });
    }),
  );
  it.effect("keeps only the current occurrence when the queue is reordered", () =>
    Effect.gen(function* () {
      const mpv = playlistOf([a, b, c], 2);
      const reordered = yield* applyQueue(mpv.session, mpv.correlation, [c, b, a], null, urls);
      expect(mpv.sent).toEqual([
        ["playlist-remove", 2],
        ["playlist-remove", 0],
        ["loadfile", "c", "insert-at", 0],
        ["loadfile", "a", "insert-at", 2],
      ]);
      expect(reordered.entries.map((entry) => entry.entryId)).toEqual(mpv.ids());
      expect(reordered.currentId).toBe(2);
    }),
  );
  it.effect("accepts an edit made while mpv advanced, and refuses one that drops the current occurrence", () =>
    Effect.gen(function* () {
      const mpv = playlistOf([a, b, c], 1);
      mpv.advanceTo(2);
      // mpv reports the advance with start-file; the edit itself is still exactly what mpv holds.
      const edited = yield* applyQueue(mpv.session, mpv.correlation, [a, b, c, d], null, urls);
      expect(edited.entries.map((entry) => entry.entryId)).toEqual([1, 2, 3, 4]);

      const before = mpv.sent.length;
      expect(yield* applyQueue(mpv.session, edited, [b, c, d], null, urls).pipe(Effect.flip)).toMatchObject({ _tag: "InvalidCommand" });
      expect(mpv.sent).toHaveLength(before);
    }),
  );
  it.effect("does not commit an uncertain edit, or a playlist that is not what was sent", () =>
    Effect.gen(function* () {
      const mpv = playlistOf([a, b], 1);
      mpv.failWith((name) => (name === "loadfile" ? new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }) : undefined));
      expect(yield* applyQueue(mpv.session, mpv.correlation, [a, b, c], null, urls).pipe(Effect.flip)).toMatchObject({ _tag: "EngineError", reason: "timeout" });
      expect(mpv.correlation.entries.map((entry) => entry.entryId)).toEqual([1, 2]);

      // The correlation claims an entry mpv does not hold.
      const stale: Correlation = { ...mpv.correlation, entries: [...mpv.correlation.entries, { ...c, entryId: 9 }] };
      mpv.failWith(undefined);
      expect(yield* applyQueue(mpv.session, stale, [a, b, c], null, urls).pipe(Effect.flip)).toMatchObject({ _tag: "QueueOutOfSync" });
    }),
  );
});
