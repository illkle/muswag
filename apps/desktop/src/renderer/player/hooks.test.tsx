// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { songRow } from "@muswag/model";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueueManagerState } from "#shared/queue-state";

const item = { key: "queued", origin: "user" as const, track: songRow({ id: "song", title: "Song" }) };
const EMPTY_QUEUE: QueueManagerState = { nowPlaying: null, userQueue: [], source: null };

const mocks = vi.hoisted(() => ({
  row: undefined as { status: string; item: unknown } | undefined,
  queue: undefined as unknown,
}));

vi.mock("#/data/state", () => ({ playerState: {} }));
vi.mock("@tanstack/react-db", () => ({ useLiveQuery: () => ({ data: mocks.row }) }));
vi.mock("#/queue/queue", () => ({ useQueueManagerState: () => mocks.queue }));

const { usePlayerCanPlay } = await import("#/player/hooks");

const canPlay = (row: typeof mocks.row, queue: QueueManagerState = EMPTY_QUEUE) => {
  mocks.row = row;
  mocks.queue = queue;
  return renderHook(() => usePlayerCanPlay()).result.current;
};

afterEach(cleanup);

describe("usePlayerCanPlay", () => {
  it("is off until the player's state has arrived", () => {
    expect(canPlay(undefined, { ...EMPTY_QUEUE, userQueue: [item] })).toBe(false);
  });

  it("is on for a track the player holds, once it has loaded", () => {
    expect(canPlay({ status: "paused", item })).toBe(true);
    expect(canPlay({ status: "stopped", item })).toBe(true);
    expect(canPlay({ status: "loading", item })).toBe(false);
  });

  it("is on with nothing in the player when the queue has a track to start with", () => {
    expect(canPlay({ status: "idle", item: null })).toBe(false);
    expect(canPlay({ status: "idle", item: null }, { ...EMPTY_QUEUE, userQueue: [item] })).toBe(true);
  });
});
