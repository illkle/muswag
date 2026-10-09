import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { layer as PathLayer } from "effect/Path";
import type { HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { albums, artists, SubsonicHttpError, type AlbumID3 } from "@muswag/model";

import { SubsonicAPI, type SubsonicApiService } from "../api/subsonic-api.js";
import { Db, write } from "../db/database.js";
import { rowOf, seed, TestDatabase } from "../test/index.js";
import { coverFileName, CoverManager, CoverManagerLive, coverMediaType, MiniFs } from "./cover-manager.js";

const owner = { type: "album", id: "album-1" } as const;
const coverPath = "covers/album_3a_album-1";

const album: AlbumID3 = {
  id: owner.id,
  name: "Album",
  artist: "Artist",
  created: "2026-01-01T00:00:00Z",
  duration: 120,
  songCount: 1,
  coverArt: "cover-1",
};

/** A cover manager over files kept in `files`, by path. */
function managerLayer(getCoverArt: SubsonicApiService["getCoverArt"], files = new Map<string, Uint8Array>()) {
  const api = { getCoverArt } as SubsonicApiService;
  const fs = Layer.succeed(MiniFs, {
    writeFile: (path, data) => Effect.sync(() => void files.set(path, data)),
    remove: (path) => Effect.sync(() => void files.delete(path)),
    exists: (path) => Effect.sync(() => files.has(path)),
  });
  return CoverManagerLive("covers").pipe(Layer.provideMerge(Layer.mergeAll(Layer.succeed(SubsonicAPI, api), fs, PathLayer)), Layer.provideMerge(TestDatabase()));
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0x00]);

const imageResponse = (bytes = JPEG) => ({ status: 200, arrayBuffer: Effect.succeed(bytes.buffer) }) as unknown as HttpClientResponse.HttpClientResponse;

/** An API that serves a JPEG and keeps the ids it was asked for. */
function servingCovers() {
  const requested: string[] = [];
  const getCoverArt: SubsonicApiService["getCoverArt"] = ({ id }) =>
    Effect.sync(() => {
      requested.push(id);
      return imageResponse();
    });
  return { requested, getCoverArt };
}

describe("CoverManager", () => {
  it.effect("downloads a cover once and serves its file from then on", () => {
    const { requested, getCoverArt } = servingCovers();
    const files = new Map<string, Uint8Array>();

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const manager = yield* CoverManager;

      expect(yield* manager.ensure(owner)).toBe(coverPath);
      expect(yield* manager.ensure(owner)).toBe(coverPath);

      expect(requested).toEqual(["cover-1"]);
      expect(files.get(coverPath)).toEqual(JPEG);
      expect((yield* rowOf(albums, owner.id))?.coverArtPath).toBe(coverPath);
    }).pipe(Effect.provide(managerLayer(getCoverArt, files)));
  });

  it.effect("shares one download between requests made at once", () => {
    let fetches = 0;
    const getCoverArt = () =>
      Effect.sync(() => {
        fetches += 1;
      }).pipe(Effect.andThen(Effect.yieldNow), Effect.as(imageResponse()));

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const manager = yield* CoverManager;

      expect(yield* Effect.all([manager.ensure(owner), manager.ensure(owner)], { concurrency: 2 })).toEqual([coverPath, coverPath]);
      expect(fetches).toBe(1);
    }).pipe(Effect.provide(managerLayer(getCoverArt)));
  });

  it.effect("downloads the cover again when its file is gone", () => {
    const { requested, getCoverArt } = servingCovers();
    const files = new Map<string, Uint8Array>();

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const manager = yield* CoverManager;
      yield* manager.ensure(owner);
      files.clear();

      expect(yield* manager.ensure(owner)).toBe(coverPath);
      expect(requested).toHaveLength(2);
      expect(files.has(coverPath)).toBe(true);
    }).pipe(Effect.provide(managerLayer(getCoverArt, files)));
  });

  it.effect("gives null without asking the server when there is no cover", () => {
    const { requested, getCoverArt } = servingCovers();

    return Effect.gen(function* () {
      yield* seed({ albums: [{ ...album, coverArt: undefined }] });
      const manager = yield* CoverManager;

      expect(yield* manager.ensure(owner)).toBeNull();
      expect(yield* manager.ensure({ type: "album", id: "unknown" })).toBeNull();
      expect(requested).toEqual([]);
    }).pipe(Effect.provide(managerLayer(getCoverArt)));
  });

  it.effect("keeps an artist's cover apart from the album of the same id", () => {
    const { requested, getCoverArt } = servingCovers();

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const db = yield* Db;
      yield* db.insert(artists).values({ id: owner.id, name: "Artist", coverArt: "artist-cover" });
      const manager = yield* CoverManager;

      expect(yield* manager.ensure({ type: "artist", id: owner.id })).toBe("covers/artist_3a_album-1");
      expect(requested).toEqual(["artist-cover"]);
      expect((yield* rowOf(artists, owner.id))?.coverArtPath).toBe("covers/artist_3a_album-1");
      expect((yield* rowOf(albums, owner.id))?.coverArtPath).toBeNull();
    }).pipe(Effect.provide(managerLayer(getCoverArt)));
  });

  it.effect("answers with a failed download for a minute instead of starting another", () => {
    let fetches = 0;
    const getCoverArt = () =>
      Effect.suspend(() => {
        fetches += 1;
        return fetches === 1 ? Effect.fail(new SubsonicHttpError({ method: "getCoverArt", status: 503, message: "getCoverArt failed: HTTP 503" })) : Effect.succeed(imageResponse());
      });

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const manager = yield* CoverManager;

      expect(Exit.isFailure(yield* Effect.exit(manager.ensure(owner)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(manager.ensure(owner)))).toBe(true);
      expect(fetches).toBe(1);

      yield* TestClock.adjust("1 minute");
      expect(yield* manager.ensure(owner)).toBe(coverPath);
      expect(fetches).toBe(2);
    }).pipe(Effect.provide(managerLayer(getCoverArt)));
  });

  it.live("answers, with an interruption, when asked after its session has closed", () => {
    const { getCoverArt } = servingCovers();

    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(managerLayer(getCoverArt), scope);
      yield* seed({ albums: [album] }).pipe(Effect.provide(context));
      const manager = Context.get(context, CoverManager);
      yield* Scope.close(scope, Exit.void);

      const answered = yield* manager.ensure(owner).pipe(Effect.exit, Effect.timeoutOption("1 second"));
      expect(Option.isSome(answered) && Exit.isFailure(answered.value)).toBe(true);
    });
  });

  it.effect("refuses what is not an image and stores nothing", () => {
    const files = new Map<string, Uint8Array>();
    const getCoverArt = () => Effect.succeed(imageResponse(new TextEncoder().encode('{"subsonic-response":{"status":"failed"}}')));

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const manager = yield* CoverManager;

      expect(Exit.isFailure(yield* Effect.exit(manager.ensure(owner)))).toBe(true);
      expect(files.size).toBe(0);
      expect((yield* rowOf(albums, owner.id))?.coverArtPath).toBeNull();
    }).pipe(Effect.provide(managerLayer(getCoverArt, files)));
  });

  it.effect("fetches the new image when the cover changes during a download", () => {
    const requested: string[] = [];
    const asked = Deferred.makeUnsafe<void>();
    const changed = Deferred.makeUnsafe<void>();
    const getCoverArt: SubsonicApiService["getCoverArt"] = ({ id }) =>
      Effect.suspend(() => {
        requested.push(id);
        if (requested.length > 1) return Effect.succeed(imageResponse());
        // The first download is held until the sync has given the album another cover.
        return Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(changed)), Effect.as(imageResponse()));
      });

    return Effect.gen(function* () {
      yield* seed({ albums: [album] });
      const db = yield* Db;
      const manager = yield* CoverManager;

      const pending = yield* Effect.forkChild(manager.ensure(owner));
      yield* Deferred.await(asked);
      yield* write(db.update(albums).set({ coverArt: "cover-2" }));
      yield* Deferred.succeed(changed, undefined);

      expect(yield* Fiber.join(pending)).toBe(coverPath);
      expect(requested).toEqual(["cover-1", "cover-2"]);
      expect(yield* rowOf(albums, owner.id)).toMatchObject({ coverArt: "cover-2", coverArtPath: coverPath });
    }).pipe(Effect.provide(managerLayer(getCoverArt)));
  });
});

describe("coverFileName", () => {
  it("gives names that every platform takes and keeps apart", () => {
    // Windows has no `:` and drops a trailing `.`; it and macOS take `A` and `a` for one name.
    expect(coverFileName({ type: "album", id: "Ab/c." })).toBe("album_3a__41_b_2f_c_2e_");
    expect(coverFileName({ type: "album", id: "ab" })).not.toBe(coverFileName({ type: "album", id: "aB" }).toLowerCase());
    expect(coverFileName({ type: "album", id: "a_b" })).not.toBe(coverFileName({ type: "album", id: "a:b" }));
  });
});

describe("coverMediaType", () => {
  it("names the image formats a cover comes in", () => {
    expect(coverMediaType(JPEG)).toBe("image/jpeg");
    expect(coverMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(coverMediaType(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBe("image/webp");
    expect(coverMediaType(new TextEncoder().encode("<html>"))).toBeNull();
  });
});
