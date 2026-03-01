import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  AlbumSchema,
  Database,
  createBetterSqliteAdapter,
  type Album,
  type DatabaseSyncOptions,
} from "../../src/index.js";

function makeAlbumList2Response(albums: Array<Record<string, unknown>>): Response {
  return new Response(
    JSON.stringify({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        albumList2: {
          album: albums,
        },
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

describe("Database consumer API", () => {
  it("syncs via query auth and returns typed albums", async () => {
    const database = new Database(createBetterSqliteAdapter(":memory:"));

    let capturedUrl: URL | null = null;

    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = new URL(typeof input === "string" ? input : input.toString());

      return makeAlbumList2Response([
        {
          id: "album-1",
          name: "Alpha",
          artist: "Artist A",
          artistId: "artist-a",
          songCount: 2,
          duration: 120,
          year: 2022,
          genre: "Indie",
          created: "2026-02-01T00:00:00Z",
        },
      ]);
    };

    const options: DatabaseSyncOptions = {
      connection: {
        baseUrl: "http://127.0.0.1:4533",
        username: "alice",
        password: "secret",
        clientName: "muswag-test",
        protocolVersion: "1.16.1",
      },
      fetchImpl,
    };

    const syncResult = await database.sync(options);

    expect(syncResult.fetched).toBe(1);
    expect(syncResult.inserted).toBe(1);
    expect(syncResult.deleted).toBe(0);

    expect(capturedUrl).not.toBeNull();
    const params = capturedUrl!.searchParams;

    expect(params.get("u")).toBe("alice");
    expect(params.get("v")).toBe("1.16.1");
    expect(params.get("c")).toBe("muswag-test");
    expect(params.get("f")).toBe("json");
    expect(params.get("s")).toMatch(/^[a-f0-9]{16}$/);
    expect(params.get("t")).toMatch(/^[a-f0-9]{32}$/);
    expect(params.has("apiKey")).toBe(false);

    const albums = await database.getAlbumList();
    const parsedAlbums = AlbumSchema.array().parse(albums);

    expect(parsedAlbums).toHaveLength(1);
    expect(parsedAlbums[0]?.name).toBe("Alpha");

    const byId = await database.getAlbumById(parsedAlbums[0]!.id);
    expect(byId?.artist).toBe("Artist A");

    expectTypeOf(albums).toEqualTypeOf<Array<z.infer<typeof AlbumSchema>>>();
    expectTypeOf<Album>().toEqualTypeOf<z.infer<typeof AlbumSchema>>();
  });

  it("reconciles deletions through consumer reads", async () => {
    const database = new Database(createBetterSqliteAdapter(":memory:"));

    const run1Fetch: typeof fetch = async () =>
      makeAlbumList2Response([
        {
          id: "a1",
          name: "Alpha",
          artist: "Artist A",
          songCount: 2,
          duration: 120,
          created: "2026-02-01T00:00:00Z",
        },
        {
          id: "b1",
          name: "Beta",
          artist: "Artist B",
          songCount: 3,
          duration: 180,
          created: "2026-02-01T00:00:00Z",
        },
      ]);

    const run2Fetch: typeof fetch = async () =>
      makeAlbumList2Response([
        {
          id: "a1",
          name: "Alpha",
          artist: "Artist A",
          songCount: 2,
          duration: 120,
          created: "2026-02-01T00:00:00Z",
        },
      ]);

    const connection = {
      baseUrl: "http://127.0.0.1:4533",
      username: "admin",
      password: "adminpass",
      clientName: "muswag-test",
    };

    const first = await database.sync({ connection, fetchImpl: run1Fetch });
    expect(first.inserted).toBe(2);

    const second = await database.sync({ connection, fetchImpl: run2Fetch });
    expect(second.deleted).toBe(1);

    const list = await database.getAlbumList();
    expect(list.map((item) => item.id)).toEqual(["a1"]);

    const deletedAlbum = await database.getAlbumById("b1");
    expect(deletedAlbum).toBeNull();
  });
});
