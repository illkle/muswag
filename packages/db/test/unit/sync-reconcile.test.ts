import { describe, expect, it } from "vitest";

import { createBetterSqliteAdapter } from "../../src/adapters/better-sqlite3.js";
import { syncAlbums } from "../../src/sync-albums.js";

function makeAlbumList2Response(albums: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        albumList2: {
          album: albums
        }
      }
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    }
  );
}

describe("syncAlbums reconcile", () => {
  it("upserts and deletes stale albums", async () => {
    const db = createBetterSqliteAdapter(":memory:");

    const run1Fetch: typeof fetch = async () =>
      makeAlbumList2Response([
        {
          id: "a1",
          name: "Alpha",
          artist: "Artist A",
          songCount: 2,
          duration: 120,
          created: "2026-02-01T00:00:00Z"
        },
        {
          id: "b1",
          name: "Beta",
          artist: "Artist B",
          songCount: 3,
          duration: 180,
          created: "2026-02-01T00:00:00Z"
        }
      ]);

    const run2Fetch: typeof fetch = async () =>
      makeAlbumList2Response([
        {
          id: "a1",
          name: "Alpha",
          artist: "Artist A",
          songCount: 2,
          duration: 120,
          created: "2026-02-01T00:00:00Z"
        }
      ]);

    const connection = {
      baseUrl: "http://127.0.0.1:4533",
      username: "admin",
      password: "adminpass",
      clientName: "muswag-test"
    };

    const first = await syncAlbums({ db, connection, fetchImpl: run1Fetch });
    expect(first.fetched).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);
    expect(first.deleted).toBe(0);

    const second = await syncAlbums({ db, connection, fetchImpl: run2Fetch });
    expect(second.fetched).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.deleted).toBe(1);

    const remainingRows = await db.query<{ id: string }>("SELECT id FROM albums ORDER BY id");
    expect(remainingRows).toEqual([{ id: "a1" }]);

    const syncState = await db.queryOne<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'albums_last_synced_at'"
    );
    expect(syncState?.value).toBeTypeOf("string");
  });
});
