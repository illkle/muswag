// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { startSongDrag, useSongDrop } from "#/lib/song-drag";

afterEach(cleanup);

it("clears a drop target when a drag is cancelled at another element", () => {
  const onDrop = vi.fn();
  function Target() {
    const drop = useSongDrop(onDrop);
    return (
      <>
        <div draggable onDragStart={(event) => startSongDrag(event, { label: "Song", songIds: async () => ["song"] })}>
          Source
        </div>
        <div {...drop.props}>{drop.over ? "Over" : "Target"}</div>
      </>
    );
  }
  render(<Target />);
  const dataTransfer = { types: [] as string[], setData: (type: string) => dataTransfer.types.push(type), setDragImage: () => {}, clearData: () => {} };
  fireEvent.dragStart(screen.getByText("Source"), { dataTransfer });
  fireEvent.dragEnter(screen.getByText("Target"), { dataTransfer });
  expect(screen.getByText("Over")).toBeTruthy();
  fireEvent.dragEnd(screen.getByText("Source"), { dataTransfer });
  expect(screen.getByText("Target")).toBeTruthy();
  expect(onDrop).not.toHaveBeenCalled();
});

it("turns away the drags a drop target does not accept, and takes the rest", () => {
  const onDrop = vi.fn();
  function Target() {
    const drop = useSongDrop(onDrop, { accepts: (drag) => drag.playlistId === undefined });
    const start = (playlistId?: string) => (event: React.DragEvent) => startSongDrag(event, { label: "Songs", songIds: async () => [], ...(playlistId ? { playlistId } : {}) });
    return (
      <>
        <div draggable onDragStart={start("mix")}>
          Playlist
        </div>
        <div draggable onDragStart={start()}>
          Album
        </div>
        <div {...drop.props}>{drop.over ? "Over" : "Target"}</div>
      </>
    );
  }
  render(<Target />);
  const dataTransfer = { types: [] as string[], setData: (type: string) => dataTransfer.types.push(type), setDragImage: () => {}, clearData: () => {} };

  fireEvent.dragStart(screen.getByText("Playlist"), { dataTransfer });
  expect(fireEvent.dragOver(screen.getByText("Target"), { dataTransfer })).toBe(true);
  fireEvent.dragEnter(screen.getByText("Target"), { dataTransfer });
  fireEvent.drop(screen.getByText("Target"), { dataTransfer });
  expect(screen.getByText("Target")).toBeTruthy();
  expect(onDrop).not.toHaveBeenCalled();

  fireEvent.dragStart(screen.getByText("Album"), { dataTransfer });
  // A drop target says it takes the drag by cancelling the drag over it.
  expect(fireEvent.dragOver(screen.getByText("Target"), { dataTransfer })).toBe(false);
  fireEvent.drop(screen.getByText("Target"), { dataTransfer });
  expect(onDrop).toHaveBeenCalledOnce();
});
