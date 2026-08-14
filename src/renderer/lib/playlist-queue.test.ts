import { describe, expect, it } from "vitest";

import { totalDuration, type PlaylistRow } from "#/lib/playlist-queue";
import type { Song } from "#core";

function song(id: string, duration?: number): Song {
  return { id, title: id, isDir: false, ...(duration === undefined ? {} : { duration }) };
}

function row(entryId: string, songId: string, resolved: Song | null): PlaylistRow {
  return { entryId, songId, song: resolved };
}

describe("totalDuration", () => {
  it("sums resolved songs and ignores unavailable ones", () => {
    const rows = [row("e1", "song-a", song("song-a", 90)), row("e2", "song-missing", null), row("e3", "song-b", song("song-b", 30)), row("e4", "song-c", song("song-c"))];

    expect(totalDuration(rows)).toBe(120);
  });
});
