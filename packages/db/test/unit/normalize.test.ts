import { describe, expect, it } from "vitest";

import { normalizeAlbumForStorage } from "../../src/sync-albums.js";

describe("normalizeAlbumForStorage", () => {
  it("normalizes with fallback name and nullable fields", () => {
    const syncedAt = "2026-03-01T00:00:00.000Z";
    const row = normalizeAlbumForStorage(
      {
        id: "album-1",
        album: "Fallback Album Name",
        songCount: 12,
        duration: 3600,
        created: "2026-02-28T10:00:00.000Z",
        artist: "Artist",
        artistId: "artist-1",
        isCompilation: true,
        musicBrainzId: "mbid-1"
      },
      syncedAt
    );

    expect(row.id).toBe("album-1");
    expect(row.name).toBe("Fallback Album Name");
    expect(row.songCount).toBe(12);
    expect(row.duration).toBe(3600);
    expect(row.isCompilation).toBe(true);
    expect(row.musicBrainzId).toBe("mbid-1");
    expect(row.syncedAt).toBe(syncedAt);
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      normalizeAlbumForStorage(
        {
          id: "album-2",
          name: "Album Two",
          duration: 1,
          created: "2026-02-28T10:00:00.000Z"
        },
        "2026-03-01T00:00:00.000Z"
      )
    ).toThrowError(/songCount/);
  });
});
