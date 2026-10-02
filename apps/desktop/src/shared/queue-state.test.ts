import { songRow } from "@muswag/model";
import { describe, expect, it } from "vitest";

import { emptyQueueState, queueItemRows, queueStateFromRows, queueStateRow, type QueueManagerState } from "./queue-state";

const item = (key: string) => ({ key, track: songRow({ id: key, title: key }) });
const sourceItem = (key: string, offset: number) => ({ ...item(key), offset });
const ref = { type: "album" as const, albumId: "album" };

const roundTrip = (state: QueueManagerState) => queueStateFromRows(queueStateRow(state, 3), queueItemRows(state));

describe("queue rows", () => {
  it("round-trips a source playing from its window", () => {
    const state: QueueManagerState = {
      nowPlaying: { ...item("b"), origin: "source" },
      userQueue: [item("user:1"), item("user:2")],
      source: { ref, window: { revision: "r", cursor: { type: "item", key: "b", offset: 1 }, previous: [sourceItem("a", 0)], current: sourceItem("b", 1), next: [sourceItem("c", 2)] } },
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
      source: { ref, window: { revision: "r", cursor: { type: "item", key: "a", offset: 0 }, previous: [], current: sourceItem("a", 0), next: [sourceItem("b", 1)] } },
    };
    expect(queueItemRows(state).at(-1)).toMatchObject({ key: "user:now", list: "now" });
    expect(roundTrip(state)).toEqual(state);
  });

  it("splits a gap cursor's window around its offset", () => {
    const state: QueueManagerState = {
      nowPlaying: { ...item("gone"), origin: "source" },
      userQueue: [],
      source: { ref, window: { revision: "r", cursor: { type: "gap", offset: 1 }, previous: [sourceItem("a", 0)], current: null, next: [sourceItem("b", 1), sourceItem("c", 2)] } },
    };
    expect(roundTrip(state)).toEqual(state);
  });

  it("reads no state row as an empty queue", () => {
    expect(queueStateFromRows(null, [{ key: "stray", list: "user", position: 0, track: item("stray").track }])).toEqual(emptyQueueState());
    expect(roundTrip(emptyQueueState())).toEqual(emptyQueueState());
  });
});
