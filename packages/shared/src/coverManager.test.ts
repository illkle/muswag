import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { layer as PathLayer } from "effect/Path";
import type { HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vitest";

import SubsonicAPI, { type SubsonicApiService } from "./api/subsonic-api.js";
import type { AlbumID3 } from "./api/subsonic-api-schema.js";
import { CoverManager, CoverManagerLive, MiniFs } from "./coverManager.js";
import { MuswagDatabase } from "./db/database.js";
import { createInMemoryDb } from "./test/database.js";

const target = {
  type: "album",
  id: "album-1",
  coverArtId: "cover-1",
} as const;

const album: AlbumID3 = {
  id: target.id,
  name: "Album",
  artist: "Artist",
  created: "2026-01-01T00:00:00Z",
  duration: 120,
  songCount: 1,
  coverArt: target.coverArtId,
};

function managerLayer({ getCoverArt, writeFile = () => Effect.void }: { getCoverArt: SubsonicApiService["getCoverArt"]; writeFile?: () => Effect.Effect<void> }) {
  const db = createInMemoryDb();
  db.albums.insert(album);

  const api = { getCoverArt } as SubsonicApiService;
  const dependencies = Layer.mergeAll(Layer.succeed(MuswagDatabase, db), Layer.succeed(SubsonicAPI, api), Layer.succeed(MiniFs, { writeFile, remove: () => Effect.void }), PathLayer);

  return { db, layer: CoverManagerLive("covers").pipe(Layer.provide(dependencies)) };
}

function jpegResponse(): HttpClientResponse.HttpClientResponse {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);
  return {
    status: 200,
    arrayBuffer: Effect.succeed(bytes.buffer),
  } as unknown as HttpClientResponse.HttpClientResponse;
}

describe("CoverManager", () => {
  it.effect("rehydrates the entity path from an existing cover row without inserting again", () => {
    let fetches = 0;
    const { db, layer } = managerLayer({
      getCoverArt: () =>
        Effect.sync(() => {
          fetches += 1;
          return jpegResponse();
        }),
    });
    const key = `album:${target.id}:${target.coverArtId}`;
    db.covers.insert({ key, fileName: `${key}.jpg` });

    return Effect.gen(function* () {
      const manager = yield* CoverManager;
      expect(yield* manager.ensure(target)).toBe(`covers/${key}.jpg`);
      expect(fetches).toBe(0);
      expect(db.albums.get(target.id)).toMatchObject({
        coverArtPath: `covers/${key}.jpg`,
        coverArtSourceId: target.coverArtId,
      });
      expect([...db.covers.keys()]).toEqual([key]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shares concurrent downloads and upserts one cover row", () => {
    let fetches = 0;
    let writes = 0;
    const { db, layer } = managerLayer({
      getCoverArt: () =>
        Effect.sync(() => {
          fetches += 1;
        }).pipe(Effect.andThen(Effect.yieldNow), Effect.as(jpegResponse())),
      writeFile: () =>
        Effect.sync(() => {
          writes += 1;
        }),
    });

    return Effect.gen(function* () {
      const manager = yield* CoverManager;
      const paths = yield* Effect.all([manager.ensure(target), manager.ensure(target)], { concurrency: 2 });

      expect(paths[0]).toBe(paths[1]);
      expect(fetches).toBe(1);
      expect(writes).toBe(1);
      expect(db.covers.size).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
