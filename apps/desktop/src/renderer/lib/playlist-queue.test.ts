import { describe, expect, it } from "vitest";

import { buildPlayQueue, currentPlaylistEntryId, totalDuration, type PlaylistRow } from "#/lib/playlist-queue";
import type { Song } from "@muswag/shared";

function song(id: string, duration?: number): Song {
  return { id, title: id, isDir: false, ...(duration === undefined ? {} : { duration }) };
}

function row(entryId: string, songId: string, resolved: Song | null): PlaylistRow {
  return { entryId, songId, song: resolved };
}

describe("buildPlayQueue", () => {
  it("skips entries that are not in the local library", () => {
    const rows = [row("e1", "song-a", song("song-a")), row("e2", "song-missing", null), row("e3", "song-b", song("song-b"))];

    const { queue } = buildPlayQueue(rows);

    expect(queue.map(({ id }) => id)).toEqual(["song-a", "song-b"]);
  });

  it("maps a row to its queue index rather than its playlist index", () => {
    const rows = [row("e1", "song-missing", null), row("e2", "song-a", song("song-a")), row("e3", "song-gone", null), row("e4", "song-b", song("song-b"))];

    const { queueIndexByEntryId } = buildPlayQueue(rows);

    expect(queueIndexByEntryId.get("e2")).toBe(0);
    expect(queueIndexByEntryId.get("e4")).toBe(1);
    expect(queueIndexByEntryId.has("e1")).toBe(false);
    expect(queueIndexByEntryId.has("e3")).toBe(false);
  });

  it("keeps duplicate songs as separate queue positions", () => {
    const rows = [row("e1", "song-a", song("song-a")), row("e2", "song-a", song("song-a")), row("e3", "song-a", song("song-a"))];

    const { queue, queueIndexByEntryId } = buildPlayQueue(rows);

    expect(queue).toHaveLength(3);
    expect([queueIndexByEntryId.get("e1"), queueIndexByEntryId.get("e2"), queueIndexByEntryId.get("e3")]).toEqual([0, 1, 2]);
  });

  it("returns an empty queue for a playlist with nothing resolvable", () => {
    const { queue, queueIndexByEntryId } = buildPlayQueue([row("e1", "song-missing", null)]);

    expect(queue).toEqual([]);
    expect(queueIndexByEntryId.size).toBe(0);
  });
});

describe("totalDuration", () => {
  it("sums resolved songs and ignores unavailable ones", () => {
    const rows = [row("e1", "song-a", song("song-a", 90)), row("e2", "song-missing", null), row("e3", "song-b", song("song-b", 30)), row("e4", "song-c", song("song-c"))];

    expect(totalDuration(rows)).toBe(120);
  });
});

describe("currentPlaylistEntryId", () => {
  it("only resolves entries from the playlist that created the player queue", () => {
    const context = { type: "playlist" as const, playlistId: "playlist-a", entryIds: ["entry-a", "entry-b"] };

    expect(currentPlaylistEntryId(context, "playlist-a", 1)).toBe("entry-b");
    expect(currentPlaylistEntryId(context, "playlist-b", 1)).toBeNull();
    expect(currentPlaylistEntryId({ type: "album", albumId: "album-a" }, "playlist-a", 1)).toBeNull();
  });
});
