import { songRow } from "@muswag/model";
import { describe, expect, it } from "vitest";

import { emptyQueueState, getQueueCanStart, queueItemRows, queueStateAt, queueStateFromRows, queueStateRow, startTarget, type QueueManagerState } from "./queue-state";

const item = (key: string) => ({ key, track: songRow({ id: key, title: key }) });
const sourceItem = (key: string, offset: number) => ({ ...item(key), offset });
const ref = { type: "album" as const, albumId: "album" };

const roundTrip = (state: QueueManagerState) => queueStateFromRows(queueStateRow(state), queueItemRows(state));

describe("queue rows", () => {
  it("round-trips a source playing from its window", () => {
    const state: QueueManagerState = {
      nowPlaying: { ...item("b"), origin: "source" },
      userQueue: [item("user:1"), item("user:2")],
      source: { ref, window: { cursor: { type: "item", key: "b", offset: 1 }, previous: [sourceItem("a", 0)], current: sourceItem("b", 1), next: [sourceItem("c", 2)], hasMore: true } },
    };
    expect(queueItemRows(state).map(({ key, list }) => [key, list])).toEqual([
      ["a", "source"],
      ["b", "source"],
      ["c", "source"],
      ["user:1", "user"],
      ["user:2", "user"],
    ]);
    expect(roundTrip(state)).toEqual(state);
  });

  it("gives a user occurrence playing between source items a row of its own", () => {
    const state: QueueManagerState = {
      nowPlaying: { ...item("user:now"), origin: "user" },
      userQueue: [],
      source: { ref, window: { cursor: { type: "item", key: "a", offset: 0 }, previous: [], current: sourceItem("a", 0), next: [sourceItem("b", 1)], hasMore: false } },
    };
    expect(queueItemRows(state).at(-1)).toMatchObject({ key: "user:now", list: "now" });
    expect(roundTrip(state)).toEqual(state);
  });

  it("splits a gap cursor's window around its offset", () => {
    const state: QueueManagerState = {
      nowPlaying: { ...item("gone"), origin: "source" },
      userQueue: [],
      source: { ref, window: { cursor: { type: "gap", offset: 1 }, previous: [sourceItem("a", 0)], current: null, next: [sourceItem("b", 1), sourceItem("c", 2)], hasMore: false } },
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it("reads no state row as an empty queue", () => {
    expect(queueStateFromRows(null, [{ key: "stray", list: "user", position: 0, track: item("stray").track }])).toEqual(emptyQueueState());
    expect(roundTrip(emptyQueueState())).toEqual(emptyQueueState());
  });
});

describe("queueStateAt", () => {
  const state: QueueManagerState = {
    nowPlaying: { ...item("b"), origin: "source" },
    userQueue: [item("user:1"), item("user:2"), item("user:3")],
    source: {
      ref,
      window: { cursor: { type: "item", key: "b", offset: 1 }, previous: [sourceItem("a", 0)], current: sourceItem("b", 1), next: [sourceItem("c", 2), sourceItem("d", 3)], hasMore: true },
    },
  };

  it("moves to a queued track, which leaves the queue with those passed over", () => {
    expect(queueStateAt(state, "user:2")).toEqual({ ...state, nowPlaying: { ...item("user:2"), origin: "user" }, userQueue: [item("user:3")] });
  });

  it("moves on in the source past the whole user queue, and back in it past none", () => {
    expect(queueStateAt(state, "d")).toEqual({
      nowPlaying: { ...item("d"), origin: "source" },
      userQueue: [],
      source: {
        ref,
        window: { cursor: { type: "item", key: "d", offset: 3 }, previous: [sourceItem("a", 0), sourceItem("b", 1), sourceItem("c", 2)], current: sourceItem("d", 3), next: [], hasMore: true },
      },
    });
    expect(queueStateAt(state, "a")).toMatchObject({
      nowPlaying: { key: "a", origin: "source" },
      userQueue: state.userQueue,
      source: { window: { cursor: { key: "a", offset: 0 }, previous: [], next: [{ key: "b" }, { key: "c" }, { key: "d" }] } },
    });
  });

  it("steps back from a queued track into the source it interrupted, keeping the rest of the queue", () => {
    const interrupted = queueStateAt(state, "user:1")!;
    expect(queueStateAt(interrupted, "b")).toEqual({ ...state, userQueue: [item("user:2"), item("user:3")] });
  });

  it("starts with the occurrence playing, or else with the next one", () => {
    expect(startTarget(state)?.key).toBe("b");
    expect(startTarget({ ...state, nowPlaying: null })?.key).toBe("user:1");
    expect(startTarget({ ...state, nowPlaying: null, userQueue: [] })?.key).toBe("c");
    expect(getQueueCanStart({ nowPlaying: null, userQueue: [item("user:1")], source: null })).toBe(true);
    expect(getQueueCanStart(emptyQueueState())).toBe(false);
  });

  it("stays on the occurrence playing, and knows no other key", () => {
    expect(queueStateAt(state, "b")).toEqual(state);
    expect(queueStateAt(state, "gone")).toBeUndefined();
    expect(queueStateAt(emptyQueueState(), "b")).toBeUndefined();
  });
});
