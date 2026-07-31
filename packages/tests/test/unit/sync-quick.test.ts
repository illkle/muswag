import { describe, expect, it, vi } from "vitest";

import { createCoverManager, sync } from "@muswag/shared";
import { albumWithSongsFixture, songFixture } from "../fixtures/sync-fixtures.js";
import { syncQuickInMemory } from "../helpers/sync-testkit.js";
import { createInMemoryDb } from "../navidrome-testkit.js";

describe("quick album sync", () => {
  it("does not fetch album details when listed shapes are unchanged", async () => {
    const album = albumWithSongsFixture({ id: "same", song: [songFixture({ id: "s1", albumId: "same" })] });
    const result = await syncQuickInMemory({ albums: [album], existingAlbums: [album], existingSongs: album.song });
    expect(result.fakeApi.albumDetailCalls).toHaveLength(0);
    expect(result.result.detailRequests).toBe(0);
  });

  it("fetches exactly one changed album", async () => {
    const incoming = albumWithSongsFixture({
      id: "changed",
      songCount: 2,
      song: [songFixture({ id: "s1", albumId: "changed" }), songFixture({ id: "s2", albumId: "changed" })],
    });
    const existing = { ...incoming, songCount: 1, song: incoming.song?.slice(0, 1) };
    const result = await syncQuickInMemory({ albums: [incoming], existingAlbums: [existing], existingSongs: existing.song });
    expect(result.fakeApi.albumDetailCalls.map(({ id }) => id)).toEqual(["changed"]);
    expect(result.state.songs).toHaveLength(2);
  });

  it("deletes albums missing from the cheap album list", async () => {
    const keep = albumWithSongsFixture({ id: "keep", song: [] });
    const remove = albumWithSongsFixture({ id: "remove", song: [songFixture({ id: "gone", albumId: "remove" })] });
    const result = await syncQuickInMemory({
      albums: [keep],
      existingAlbums: [keep, remove],
      existingSongs: remove.song,
    });
    expect(result.result.deletedAlbumIds).toEqual(["remove"]);
    expect(result.state.songs).toHaveLength(0);
  });

  it("forces a full sync when the album collection is empty", async () => {
    const db = createInMemoryDb();
    db.userCredentials.insert({ id: 1, url: "https://music.example", username: "user", password: "pass" });
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const payload = url.pathname.includes("getIndexes") ? { indexes: { lastModified: 123, index: [] } } : { albumList2: { album: [] } };
      return new Response(JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...payload } }));
    });
    try {
      const covers = createCoverManager({
        db,
        store: {
          async fetch() {
            return undefined;
          },
          async remove() {},
        },
      });
      const result = await sync(db, covers, { mode: "quick", covers: "skip" });
      expect(result.mode).toBe("full");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
