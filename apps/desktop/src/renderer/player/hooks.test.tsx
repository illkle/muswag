// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { songRow } from "@muswag/model";
import { createStore } from "@tanstack/react-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QueueManagerState } from "#shared/queue-state";

const item = { key: "queued", origin: "user" as const, track: songRow({ id: "song", title: "Song" }) };
const EMPTY_QUEUE: QueueManagerState = { nowPlaying: null, userQueue: [], source: null };

/** A store of what main publishes, as `appState` holds it: `undefined` until it has arrived. */
function fakeState<Value>() {
  const store = createStore<Value | undefined>(undefined);
  return Object.assign(store, { set: (next: Value | undefined) => store.setState(() => next) });
}

const mocks = { queue: EMPTY_QUEUE };
const collections = {
  player: fakeState<{ status: string; item: unknown; error?: null }>(),
  position: fakeState<{ positionSeconds: number; durationSeconds: number | null }>(),
};

// The factories run at the import below, once the stores are there.
vi.mock("#/data/app-state", () => ({ appState: { player: collections.player, playerPosition: collections.position } }));
vi.mock("#/queue/queue", () => ({ useQueueSelector: (select: (queue: QueueManagerState) => unknown) => select(mocks.queue) }));

const { usePlayerCanGoBack, usePlayerCanPlay, usePlayerConnected, usePlayerError } = await import("#/player/hooks");

const canPlay = (row: { status: string; item: unknown } | undefined, queue: QueueManagerState = EMPTY_QUEUE) => {
  collections.player.set(row);
  mocks.queue = queue;
  return renderHook(() => usePlayerCanPlay()).result.current;
};

afterEach(() => {
  cleanup();
  collections.player.set(undefined);
  collections.position.set(undefined);
});

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

describe("player state", () => {
  it("is disconnected until the player's state has arrived, and follows it from then on", () => {
    const { result } = renderHook(() => ({ connected: usePlayerConnected(), error: usePlayerError() }));
    expect(result.current.connected).toBe(false);
    expect(result.current.error?.message).toMatch(/disconnected/);

    act(() => collections.player.set({ status: "idle", item: null, error: null }));
    expect(result.current).toEqual({ connected: true, error: null });
  });
});

describe("usePlayerCanGoBack", () => {
  it("restarts a track once it has started, without re-rendering as it plays", () => {
    collections.player.set({ status: "playing", item });
    mocks.queue = { ...EMPTY_QUEUE, nowPlaying: item };
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return usePlayerCanGoBack();
    });
    expect(result.current).toBe(false);

    act(() => collections.position.set({ positionSeconds: 1, durationSeconds: 200 }));
    expect(result.current).toBe(true);
    const rendered = renders;

    act(() => collections.position.set({ positionSeconds: 2, durationSeconds: 200 }));
    act(() => collections.position.set({ positionSeconds: 3, durationSeconds: 200 }));
    expect(renders).toBe(rendered);
  });
});
