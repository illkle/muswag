import { describe, expect, it } from "vitest";

import type SubsonicAPI from "#subsonic-api";
import { SubsonicApiError } from "#subsonic-api";
import { syncArtists } from "#core";
import { createInMemoryDb } from "#core/testing/database";

function fakeApi(index: { id: string; name: string; coverArt?: string }[] | undefined, lastModified = 1234): SubsonicAPI {
  return {
    async getIndexes() {
      return {
        status: "ok",
        version: "1.16.1",
        indexes: { lastModified, ...(index === undefined ? {} : { index: [{ name: "A", artist: index }] }) },
      };
    },
  } as unknown as SubsonicAPI;
}

describe("syncArtists", () => {
  it("flattens and upserts index artists", async () => {
    const db = createInMemoryDb();
    const result = await syncArtists({
      api: fakeApi([{ id: "a1", name: "Artist", coverArt: "cover-a1" }]),
      db,
      syncId: "artists",
    });
    expect(db.artists.get("a1")).toMatchObject({ name: "Artist", coverArt: "cover-a1" });
    expect(result).toMatchObject({ lastModified: 1234, libraryChanged: true, inserted: 1 });
  });

  it("does no writes when index is absent", async () => {
    const db = createInMemoryDb();
    db.artists.insert({ id: "a1", name: "Existing" });
    const result = await syncArtists({ api: fakeApi(undefined, 4567), db, syncId: "artists", ifModifiedSince: 1234 });
    expect(db.artists.get("a1")?.name).toBe("Existing");
    expect(result).toMatchObject({ lastModified: 4567, libraryChanged: false, inserted: 0, updated: 0, deleted: 0 });
  });

  it("deletes artists removed from a changed index", async () => {
    const db = createInMemoryDb();
    db.artists.insert([
      { id: "keep", name: "Keep" },
      { id: "remove", name: "Remove" },
    ]);
    const result = await syncArtists({ api: fakeApi([{ id: "keep", name: "Keep" }]), db, syncId: "artists", ifModifiedSince: 1 });
    expect([...db.artists.keys()]).toEqual(["keep"]);
    expect(result.deletedArtistIds).toEqual(["remove"]);
  });

  it("treats error 70 as an empty library without advancing the watermark", async () => {
    const db = createInMemoryDb();
    db.artists.insert({ id: "old", name: "Old" });
    const api = {
      async getIndexes() {
        throw new SubsonicApiError("Library not found or empty", { code: 70 });
      },
    } as unknown as SubsonicAPI;
    const result = await syncArtists({ api, db, syncId: "artists", ifModifiedSince: 100 });
    expect(db.artists.size).toBe(0);
    expect(result.lastModified).toBeNull();
  });
});
