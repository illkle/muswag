// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PlaylistSummary } from "#/lib/playlist-queries";

const mocks = vi.hoisted(() => ({
  playlists: [] as PlaylistSummary[],
  addSongs: vi.fn(),
  createWithSongs: vi.fn(),
  setComment: vi.fn(),
  setVisibility: vi.fn(),
}));

vi.mock("#/lib/playlist-queries", () => ({
  usePlaylists: () => ({ playlists: mocks.playlists }),
}));

vi.mock("#/lib/playlist-actions", () => ({
  PlaylistActions: {
    addSongs: mocks.addSongs,
    createWithSongs: mocks.createWithSongs,
    setComment: mocks.setComment,
    setVisibility: mocks.setVisibility,
  },
}));

vi.mock("#/components/playlist/playlist-form-dialog", () => ({
  PlaylistFormDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="create-dialog" /> : null),
}));

const { AddToPlaylistMenu } = await import("#/components/playlist/add-to-playlist-menu");

function summary(id: string, name: string, readonly = false): PlaylistSummary {
  return { id, name, comment: "", songCount: 0, readonly, localOnly: false, owner: undefined };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.playlists = [];
});

function renderMenu(songIds: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AddToPlaylistMenu songIds={songIds} />
    </QueryClientProvider>,
  );
}

describe("AddToPlaylistMenu", () => {
  it("opens without Base UI structure errors and lists writable playlists", async () => {
    // Base UI throws when menu parts are used outside their required context, so a failed
    // structure surfaces here as a render error rather than a missing element.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.playlists = [summary("p1", "Road trip"), summary("p2", "Someone else's", true)];

    renderMenu(["song-a"]);
    fireEvent.click(screen.getByLabelText("Add to playlist"));

    await waitFor(() => expect(screen.getByText("Road trip")).toBeTruthy());
    expect(screen.queryByText("Someone else's")).toBeNull();
    expect(screen.getByText(/Add 1 song to/)).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("adds the songs to the chosen playlist", async () => {
    mocks.playlists = [summary("p1", "Road trip")];

    renderMenu(["song-a", "song-b"]);
    fireEvent.click(screen.getByLabelText("Add to playlist"));
    await waitFor(() => expect(screen.getByText("Road trip")).toBeTruthy());

    fireEvent.click(screen.getByText("Road trip"));

    await waitFor(() => expect(mocks.addSongs).toHaveBeenCalledWith("p1", ["song-a", "song-b"]));
  });

  it("still offers a new playlist when nothing is writable", async () => {
    mocks.playlists = [summary("p2", "Someone else's", true)];

    renderMenu(["song-a"]);
    fireEvent.click(screen.getByLabelText("Add to playlist"));

    await waitFor(() => expect(screen.getByText("No editable playlists")).toBeTruthy());
    expect(screen.getByText("New playlist...")).toBeTruthy();
  });
});
