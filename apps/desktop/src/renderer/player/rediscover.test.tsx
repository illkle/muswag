// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BinaryState } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({ binary: { _tag: "Checking" } as BinaryState, recheck: vi.fn(async () => {}) }));

vi.mock("#/player/commands", () => ({ MpvIPC: { recheck: mocks.recheck } }));
vi.mock("#/player/hooks", () => ({ usePlayerMpvBinary: () => mocks.binary }));

import { useRediscoverMpvOnFocus } from "./rediscover";

afterEach(() => {
  cleanup();
});

describe("rediscovering mpv", () => {
  it("looks again when the window comes back to the front, only while mpv is missing", () => {
    mocks.binary = { _tag: "Unavailable", message: "mpv was not found.", options: [], searched: [] };
    const view = renderHook(() => useRediscoverMpvOnFocus());

    act(() => void window.dispatchEvent(new Event("focus")));
    expect(mocks.recheck).toHaveBeenCalledOnce();

    mocks.binary = { _tag: "Ready", path: "/usr/bin/mpv", source: "well-known", version: "0.41.0" };
    view.rerender();
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(mocks.recheck).toHaveBeenCalledOnce();
  });
});
