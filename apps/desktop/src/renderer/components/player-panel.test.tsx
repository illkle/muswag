// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  muted: false,
  volumePercent: 20,
  setMuted: vi.fn(async () => {}),
  setVolume: vi.fn<(percent: number) => Promise<void>>(),
}));

vi.mock("#/player/commands", () => ({ MpvIPC: {}, PlayerIPC: { setMuted: mocks.setMuted, setVolume: mocks.setVolume } }));
vi.mock("#/player/hooks", () => ({ usePlayerMuted: () => mocks.muted, usePlayerVolumePercent: () => mocks.volumePercent }));
vi.mock("#/data/library", () => ({ db: {} }));
vi.mock("#/queue/queue", () => ({ QueueActions: {} }));
vi.mock("#/components/queue-panel", () => ({ QueuePanelToggle: () => null }));
vi.mock("#/components/album-list/album-cover", () => ({ AlbumCover: () => null }));
vi.mock("#/components/utils/artist-links", () => ({ ArtistLinks: () => null }));

import { PlayerVolume } from "./player-panel";

/** A `setVolume` call main has not answered yet. */
function pendingSend() {
  let resolve = () => {};
  mocks.setVolume.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
  return () => act(async () => resolve());
}

const slider = () => screen.getByLabelText<HTMLInputElement>("Playback volume");
const drag = (percent: number) => fireEvent.change(slider(), { target: { value: String(percent) } });

describe("PlayerVolume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.muted = false;
    mocks.volumePercent = 20;
    mocks.setVolume.mockReset().mockResolvedValue(undefined);
    // jsdom has no pointer capture.
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends the latest value at most once per interval while dragging", () => {
    render(<PlayerVolume />);

    fireEvent.pointerDown(slider());
    drag(40);
    drag(45);
    drag(50);
    expect(mocks.setVolume.mock.calls).toEqual([[40]]);

    act(() => void vi.advanceTimersByTime(100));
    expect(mocks.setVolume.mock.calls).toEqual([[40], [50]]);
  });

  it("keeps the dragged value while main reports earlier ones", async () => {
    const view = render(<PlayerVolume />);

    fireEvent.pointerDown(slider());
    drag(40);
    drag(50);

    mocks.volumePercent = 40;
    view.rerender(<PlayerVolume />);
    await act(async () => {});

    expect(slider().value).toBe("50");
  });

  it("sends what is unsent on release and shows main's volume once it has answered", async () => {
    const view = render(<PlayerVolume />);

    fireEvent.pointerDown(slider());
    drag(40);
    await act(async () => {});
    const answer = pendingSend();
    drag(60);
    fireEvent.pointerUp(slider());
    expect(mocks.setVolume.mock.calls).toEqual([[40], [60]]);

    mocks.volumePercent = 40;
    view.rerender(<PlayerVolume />);
    expect(slider().value).toBe("60");

    // mpv may apply something other than what was asked for.
    mocks.volumePercent = 58;
    await answer();
    expect(slider().value).toBe("58");
  });
});
