// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Song } from "@muswag/shared";

vi.mock("@tanstack/react-router", () => ({
  useElementScrollRestoration: () => undefined,
  Link: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("#/lib/db-renderer", () => ({ db: {} }));

vi.mock("#/core/playlist-actions", () => ({
  PlaylistActions: {
    addSongs: vi.fn(),
    createWithSongs: vi.fn(),
    setComment: vi.fn(),
    setVisibility: vi.fn(),
  },
}));

vi.mock("#/components/playlist/add-to-playlist-menu", () => ({ AddToPlaylistMenu: () => null }));
vi.mock("#/components/playlist/playlist-form-dialog", () => ({ PlaylistFormDialog: () => null }));
vi.mock("#/components/player-provider", () => ({ queueManager: { enqueue: vi.fn() } }));

vi.mock("@tanstack/react-db", () => ({
  useLiveQuery: () => ({ data: undefined }),
  eq: () => undefined,
}));

const { SongListRoot } = await import("#/components/song-list");
type SongVisualProps = import("#/components/song-list").SongVisualProps;

beforeAll(() => {
  // jsdom reports zero-sized elements, so the virtualizer would render no rows.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;

  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
});

afterEach(() => {
  cleanup();
});

function song(id: string, title: string): Song {
  return { id, title, isDir: false };
}

/** A playlist holding the same track three times, which is legal and must stay independently addressable. */
const duplicateSongs = [song("song-a", "Repeat"), song("song-a", "Repeat"), song("song-a", "Repeat")];
const entryKeys = ["entry-1", "entry-2", "entry-3"];

function Row({ song: rowSong, index, isSelected, isPlaying, status: _status, isUnavailable: _isUnavailable, ...props }: SongVisualProps) {
  return (
    <div data-testid={`row-${index}`} data-selected={isSelected ? "true" : "false"} data-playing={isPlaying ? "true" : "false"} {...props}>
      {rowSong.title}
    </div>
  );
}

describe("SongListRoot row identity", () => {
  it("selects only the clicked row when the same song repeats", () => {
    render(<SongListRoot songs={duplicateSongs} rowKeys={entryKeys} onSongPlay={() => undefined} currentTrackID={null} playerStatus={null} SongComponent={Row} scrollId="test" />);

    fireEvent.click(screen.getByTestId("row-1"));

    expect(screen.getByTestId("row-0").dataset.selected).toBe("false");
    expect(screen.getByTestId("row-1").dataset.selected).toBe("true");
    expect(screen.getByTestId("row-2").dataset.selected).toBe("false");
  });

  it("selects every duplicate together when no row keys are supplied", () => {
    // React warns about the duplicate keys this fallback produces; that is the point of the test.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<SongListRoot songs={duplicateSongs} onSongPlay={() => undefined} currentTrackID={null} playerStatus={null} SongComponent={Row} scrollId="test-no-keys" />);

    fireEvent.click(screen.getByTestId("row-1"));

    // Falling back to the song id makes the three rows indistinguishable — why playlists pass keys.
    expect(screen.getByTestId("row-0").dataset.selected).toBe("true");
    expect(screen.getByTestId("row-2").dataset.selected).toBe("true");
    consoleError.mockRestore();
  });

  it("marks only the playing row when playingRowKey is supplied", () => {
    render(
      <SongListRoot
        songs={duplicateSongs}
        rowKeys={entryKeys}
        playingRowKey="entry-3"
        onSongPlay={() => undefined}
        currentTrackID="song-a"
        playerStatus="playing"
        SongComponent={Row}
        scrollId="test-playing"
      />,
    );

    expect(screen.getByTestId("row-0").dataset.playing).toBe("false");
    expect(screen.getByTestId("row-1").dataset.playing).toBe("false");
    expect(screen.getByTestId("row-2").dataset.playing).toBe("true");
  });

  it("reports the clicked index so callers can resolve which duplicate was played", () => {
    const onSongPlay = vi.fn();
    render(<SongListRoot songs={duplicateSongs} rowKeys={entryKeys} onSongPlay={onSongPlay} currentTrackID={null} playerStatus={null} SongComponent={Row} scrollId="test-play" />);

    fireEvent.doubleClick(screen.getByTestId("row-2"));

    expect(onSongPlay).toHaveBeenCalledWith(duplicateSongs[2], 2);
  });
});
