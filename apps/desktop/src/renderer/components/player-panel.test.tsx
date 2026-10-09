// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayerError } from "#shared/commands/player";

const mocks = vi.hoisted(() => ({
  muted: false,
  volumePercent: 20,
  positionSeconds: 100,
  error: null as PlayerError | null,
  setMuted: vi.fn(async () => {}),
  setVolume: vi.fn<(percent: number) => Promise<void>>(),
  play: vi.fn(async () => {}),
  pause: vi.fn(async () => {}),
  seek: vi.fn<(seconds: number) => Promise<void>>(),
  dismissError: vi.fn(async () => {}),
  locate: vi.fn(async () => {}),
  recheck: vi.fn(async () => {}),
  status: "paused",
  canGoForward: false,
  startQueue: vi.fn(async () => {}),
  next: vi.fn(async () => {}),
  noticed: vi.fn<(message: string, cause: unknown) => void>(),
}));

vi.mock("#/player/commands", () => ({
  MpvIPC: { locate: mocks.locate, recheck: mocks.recheck },
  PlayerIPC: { setMuted: mocks.setMuted, setVolume: mocks.setVolume, play: mocks.play, pause: mocks.pause, seek: mocks.seek, dismissError: mocks.dismissError },
}));
// A paused track of four minutes, a hundred seconds in.
vi.mock("#/player/hooks", () => ({
  usePlayerMuted: () => mocks.muted,
  usePlayerVolumePercent: () => mocks.volumePercent,
  usePlayerCanGoBack: () => false,
  usePlayerCanGoForward: () => mocks.canGoForward,
  usePlayerCanPlay: () => true,
  usePlayerCanSeek: () => true,
  usePlayerConnected: () => true,
  usePlayerError: () => mocks.error,
  usePlayerBuffering: () => false,
  usePlayerCurrentTrackId: () => "track",
  usePlayerCurrentTrack: () => null,
  usePlayerDuration: () => 240,
  usePlayerPositionSeconds: () => mocks.positionSeconds,
  usePlayerStatus: () => mocks.status,
}));
vi.mock("#/data/library", () => ({ db: {} }));
vi.mock("#/queue/queue", () => ({ QueueActions: { play: mocks.startQueue, next: mocks.next } }));
vi.mock("#/lib/notify", () => ({ failureNotice: (message: string) => (cause: unknown) => mocks.noticed(message, cause) }));
vi.mock("#/components/queue-panel", () => ({ QueuePanelToggle: () => null }));
vi.mock("#/components/album-list/album-cover", () => ({ AlbumCover: () => null }));
vi.mock("#/components/utils/artist-links", () => ({ ArtistLinks: () => null }));
vi.mock("@tanstack/react-db", () => ({ eq: () => true, useLiveQuery: () => ({ data: undefined }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a> }));

import { PlayerPanel, PlayerVolume } from "./player-panel";

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

describe("PlayerPanel", () => {
  const seekSlider = () => screen.getByLabelText<HTMLInputElement>("Playback position");
  const space = (target: Element) => fireEvent.keyDown(target, { key: " ", code: "Space" });

  beforeEach(() => {
    mocks.positionSeconds = 100;
    mocks.error = null;
    mocks.status = "paused";
    mocks.canGoForward = false;
    for (const mock of [mocks.play, mocks.pause, mocks.dismissError, mocks.locate, mocks.recheck, mocks.startQueue, mocks.noticed]) mock.mockClear();
    mocks.next.mockReset().mockResolvedValue(undefined);
    mocks.seek.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("toggles playback on Space, also with a slider focused, which has no use for it", () => {
    render(<PlayerPanel />);

    space(document.body);
    expect(mocks.play).toHaveBeenCalledTimes(1);

    seekSlider().focus();
    space(seekSlider());
    expect(mocks.play).toHaveBeenCalledTimes(2);
  });

  it("starts the queue with Play when the player holds no track", () => {
    mocks.status = "idle";
    render(<PlayerPanel />);

    fireEvent.click(screen.getByRole("button", { name: "Play track" }));
    space(document.body);

    expect(mocks.startQueue).toHaveBeenCalledTimes(2);
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("says so when a command of the queue fails, which the player's banner would not", async () => {
    mocks.canGoForward = true;
    const refused = new Error("The source is gone.");
    mocks.next.mockRejectedValueOnce(refused);
    render(<PlayerPanel />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next track" })));

    expect(mocks.noticed).toHaveBeenCalledExactlyOnceWith("The next track could not be played.", refused);
  });

  it("leaves Space to a field, to a button reached by keyboard and to anything in a dialog", () => {
    render(
      <>
        <PlayerPanel />
        <input aria-label="Search" />
        <div role="dialog">
          <button>Confirm</button>
        </div>
      </>,
    );

    for (const target of [screen.getByLabelText("Search"), screen.getByRole("button", { name: "Confirm" }), screen.getByRole("button", { name: "Next track" })]) {
      target.focus();
      // Not prevented either, so the press still does what it does to the element.
      expect(space(target)).toBe(true);
    }
    expect(mocks.play).not.toHaveBeenCalled();
  });

  it("steps five seconds on an arrow key, but not into the end of the track", () => {
    render(<PlayerPanel />);

    seekSlider().focus();
    fireEvent.keyDown(seekSlider(), { key: "ArrowRight" });
    fireEvent.keyUp(seekSlider(), { key: "ArrowRight" });
    expect(mocks.seek.mock.calls).toEqual([[105]]);
  });

  it("does not seek to the end, which would skip to the next track, on an arrow key in the last seconds", () => {
    mocks.positionSeconds = 237;
    render(<PlayerPanel />);

    seekSlider().focus();
    fireEvent.keyDown(seekSlider(), { key: "ArrowRight" });
    fireEvent.keyUp(seekSlider(), { key: "ArrowRight" });
    expect(mocks.seek).not.toHaveBeenCalled();
    expect(seekSlider().value).toBe("237");
  });

  it("shows the position it sent until main has answered, then main's", async () => {
    let answer = () => {};
    mocks.seek.mockImplementationOnce(() => new Promise<void>((done) => (answer = done)));
    const view = render(<PlayerPanel />);

    seekSlider().focus();
    fireEvent.keyDown(seekSlider(), { key: "ArrowRight" });
    fireEvent.keyUp(seekSlider(), { key: "ArrowRight" });
    // mpv is still on its way: positions it reports from before the seek do not move the slider back.
    mocks.positionSeconds = 100.5;
    view.rerender(<PlayerPanel />);
    expect(seekSlider().value).toBe("105");

    mocks.positionSeconds = 104.6;
    await act(async () => answer());
    expect(seekSlider().value).toBe("104.6");
  });

  it("says what went wrong and offers what can be done about it", () => {
    mocks.error = { message: "The track could not be played after retrying.", fix: "retry" };
    const view = render(<PlayerPanel />);

    expect(screen.getByRole("alert").textContent).toContain("The track could not be played after retrying.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(mocks.dismissError).toHaveBeenCalledOnce();

    mocks.error = { message: "mpv was not found. Install it, or select its executable.", fix: "mpv" };
    view.rerender(<PlayerPanel />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Locate mpv" }));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(mocks.locate).toHaveBeenCalledOnce();
    expect(mocks.recheck).toHaveBeenCalledOnce();

    mocks.error = null;
    view.rerender(<PlayerPanel />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
