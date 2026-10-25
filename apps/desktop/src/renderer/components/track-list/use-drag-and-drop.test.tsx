// @vitest-environment jsdom

import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { afterEach, expect, it, vi } from "vitest";

import { songRow } from "@muswag/model";

import type { TrackItem } from "#/components/track-list/types";
import { useDragAndDrop, type TrackListDrop } from "#/components/track-list/use-drag-and-drop";
import { useKeySelection } from "#/components/track-list/use-selection";
import { startSongDrag, type SongDrag } from "#/lib/song-drag";

afterEach(cleanup);

const track = (key: string, unavailable = false): TrackItem => ({ type: "track", key, song: songRow({ id: `song-${key}`, title: key }), unavailable });
/** Two rows 48 pixels high, as the list draws them. */
const virtualRows: VirtualItem[] = [0, 1].map((index) => ({ index, key: index, start: index * 48, end: (index + 1) * 48, size: 48, lane: 0 }));

/** A list of `tracks` that drags and drops as `drop` says, and drags its songs as they are. */
function List({ tracks, drop }: { tracks: TrackItem[]; drop?: TrackListDrop }) {
  const selection = useKeySelection(tracks);
  const { props } = useDragAndDrop({ selection, dragOf: (dragged) => ({ label: dragged.items[0]!.key, songIds: dragged.songIds }), drop, virtualRows });
  return (
    <div data-testid="list" {...props}>
      {tracks.map(({ key }, position) => (
        <div key={key} draggable data-track-position={position}>
          {key}
        </div>
      ))}
    </div>
  );
}

// jsdom has no DataTransfer; this carries the types from the start of a drag to its drop, as the browser's would.
const dataTransferOf = () => {
  const dataTransfer = { types: [] as string[], setData: (type: string) => dataTransfer.types.push(type), setDragImage: () => {}, clearData: () => {}, effectAllowed: "", dropEffect: "" };
  return dataTransfer;
};
/** A drag of `drag` started somewhere outside the list. */
function dragFromElsewhere(drag: SongDrag) {
  const dataTransfer = dataTransferOf();
  startSongDrag({ dataTransfer } as never, drag);
  return dataTransfer;
}
/** An event of a drag on the list at 60 pixels down, in the upper half of the second row. */
const at60 = (create: typeof createEvent.dragOver, dataTransfer: object) => {
  const list = screen.getByTestId("list");
  const event = Object.defineProperty(create(list, { dataTransfer }), "clientY", { value: 60 });
  fireEvent(list, event);
  return event;
};
const dragOverAt60 = (dataTransfer: object) => at60(createEvent.dragOver, dataTransfer);
const dropAt60 = (dataTransfer: object) => at60(createEvent.drop, dataTransfer);

it("does not drag a song that is not in the library", () => {
  render(<List tracks={[track("a"), track("missing", true)]} />);

  const event = createEvent.dragStart(screen.getByText("missing"), { dataTransfer: dataTransferOf() });
  fireEvent(screen.getByText("missing"), event);
  expect(event.defaultPrevented).toBe(true);
});

it("moves its own rows dropped back on it, and adds songs from elsewhere", () => {
  const onDrop = vi.fn();
  render(<List tracks={[track("a"), track("b")]} drop={{ list: "queue", gapAt: (index, after) => (after ? index + 1 : index), onDrop }} />);

  const own = dragFromElsewhere({ label: "a", songIds: async () => [], rows: { list: "queue", keys: ["a"] } });
  expect(dragOverAt60(own).defaultPrevented).toBe(true);
  expect(own.dropEffect).toBe("move");

  const other = dragFromElsewhere({ label: "x", songIds: async () => [] });
  dragOverAt60(other);
  expect(other.dropEffect).toBe("copy");
});

it("leaves the drags it does not accept, and the gaps it has none for, to the browser", () => {
  const onDrop = vi.fn();
  const { rerender } = render(<List tracks={[track("a"), track("b")]} drop={{ accepts: (drag) => drag.playlistId === undefined, gapAt: (index) => index, onDrop }} />);

  const playlist = dragFromElsewhere({ label: "mix", songIds: async () => [], playlistId: "mix" });
  expect(dragOverAt60(playlist).defaultPrevented).toBe(false);
  expect(dropAt60(playlist).defaultPrevented).toBe(false);

  rerender(<List tracks={[track("a"), track("b")]} drop={{ gapAt: () => null, onDrop }} />);
  const songs = dragFromElsewhere({ label: "x", songIds: async () => [] });
  expect(dragOverAt60(songs).defaultPrevented).toBe(false);
  expect(dropAt60(songs).defaultPrevented).toBe(false);
  expect(onDrop).not.toHaveBeenCalled();
});
