import { describe, expect, it } from "vitest";

import type SubsonicAPI from "@muswag/subsonic-api";
import { refreshAlbumStats } from "@muswag/shared";
import { albumWithSongsFixture, songFixture } from "../fixtures/sync-fixtures.js";
import { createInMemoryDb } from "../navidrome-testkit.js";

describe("refreshAlbumStats", () => {
  it("suppresses fresh requests with the TTL", async () => {
    const db = createInMemoryDb();
    const { song: _song, ...album } = albumWithSongsFixture({ id: "fresh" });
    db.albums.insert({ ...album, coverArtPath: undefined, statsRefreshedAt: new Date().toISOString() });
    let calls = 0;
    const api = {
      async getAlbum() {
        calls += 1;
        throw new Error("unexpected");
      },
    } as unknown as SubsonicAPI;
    expect(await refreshAlbumStats(db, api, "fresh")).toBe(false);
    expect(calls).toBe(0);
  });

  it("updates only stat fields on albums and songs", async () => {
    const db = createInMemoryDb();
    const originalSong = songFixture({ id: "song", albumId: "stats", title: "Local title", playCount: 1 });
    const { song: _song, ...album } = albumWithSongsFixture({ id: "stats", name: "Local album", playCount: 1 });
    db.albums.insert({ ...album, coverArtPath: undefined });
    db.songs.insert(originalSong);
    const incoming = albumWithSongsFixture({
      id: "stats",
      name: "Server rename must not win",
      playCount: 9,
      song: [{ ...originalSong, title: "Server title must not win", playCount: 7, starred: "2026-01-01" }],
    });
    const api = {
      async getAlbum() {
        return { album: incoming };
      },
    } as unknown as SubsonicAPI;
    expect(await refreshAlbumStats(db, api, "stats", { maxAgeMs: 0 })).toBe(true);
    expect(db.albums.get("stats")).toMatchObject({ name: "Local album", playCount: 9 });
    expect(db.albums.get("stats")?.statsRefreshedAt).toBeTruthy();
    expect(db.songs.get("song")).toMatchObject({ title: "Local title", playCount: 7, starred: "2026-01-01" });
  });
});
