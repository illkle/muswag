// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { createStore } from "@tanstack/react-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnplayableTrack } from "#shared/state/queue";

const mocks = vi.hoisted(() => ({ notices: [] as string[] }));
const unplayable = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock("#/data/app-state", async () => {
  const { createStore } = await import("@tanstack/react-store");
  unplayable.store = createStore<ReadonlyArray<UnplayableTrack> | undefined>(undefined);
  return { appState: { unplayable: unplayable.store } };
});
vi.mock("#/lib/notify", () => ({ notifyFailure: (message: string) => mocks.notices.push(message) }));

const { useSkippedTrackNotices, useSongIsUnplayable } = await import("./unplayable");
const store = unplayable.store as ReturnType<typeof createStore<ReadonlyArray<UnplayableTrack> | undefined>>;
const publish = (tracks: ReadonlyArray<UnplayableTrack>) => act(() => store.setState(() => tracks));
const track = (id: string, at: number, skipped = true): UnplayableTrack => ({ id, title: `Song ${id}`, skipped, at });

afterEach(() => {
  cleanup();
  mocks.notices.length = 0;
  store.setState(() => undefined);
});

describe("unplayable tracks", () => {
  it("tells each skip once, from when the window was there, and not a track the queue stayed on", () => {
    const now = Date.now();
    publish([track("before", now - 1_000)]);
    renderHook(() => useSkippedTrackNotices());

    publish([track("before", now - 1_000), track("a", now + 10_000)]);
    publish([track("before", now - 1_000), track("a", now + 10_000), track("stayed", now + 20_000, false)]);
    // Skipped again later: told again.
    publish([track("a", now + 30_000)]);
    expect(mocks.notices).toEqual(["“Song a” could not be played and was skipped.", "“Song a” could not be played and was skipped."]);
  });

  it("marks the songs the player could not play", () => {
    publish([track("a", 1)]);
    expect(renderHook(() => useSongIsUnplayable("a")).result.current).toBe(true);
    expect(renderHook(() => useSongIsUnplayable("b")).result.current).toBe(false);
  });
});
