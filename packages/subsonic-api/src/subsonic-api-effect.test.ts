import { Cause, Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vitest";
import { createHash, getRandomValues } from "node:crypto";
import { it } from "@effect/vitest";

import SubsonicAPI, { SubsonicAPILive, type SubsonicApiService, SubsonicCrypto } from "./effect.js";
import { HttpClientError, TransportError } from "effect/unstable/http/HttpClientError";

/*
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


async function createApi(payload: unknown, urls: URL[] = []): Promise<SubsonicApiService> {
  const client = HttpClient.make((request, url) => {
    urls.push(url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(payload)));
  });

  const layerWithoutDeps = SubsonicAPILive({
    url: "https://music.example",
    auth: { username: "alice", password: "secret" },
  });

  const deps = Layer.merge(
    Layer.succeed(HttpClient.HttpClient, client),

    Layer.succeed(
      SubsonicCrypto,
      SubsonicCrypto.of({
        md5: (v) => Effect.succeed("md5:" + v),
        cachedSaltGenerator: () => "secretfixed-salt",
      }),
    ),
  );

  const full = layerWithoutDeps.pipe(Layer.provide(deps));
}
  */

describe("Effect SubsonicAPI", () => {
  it.effect("correctly makes request to getAlbumList2 and parses result", () =>
    Effect.gen(function* () {
      const fakeHttpClient = HttpClient.make((request, url) => {
        expect(request.method).toBe("POST");
        expect(url.origin).toBe("https://music.k.com");
        expect(url.pathname).toBe("/rest/getAlbumList2.view");

        expect(url.toString()).toMatchInlineSnapshot(`"https://music.k.com/rest/getAlbumList2.view"`);

        const body = request.body;

        if (body._tag !== "Uint8Array") {
          throw new Error(`Unexpected body type: ${body._tag}`);
        }

        const bodyString = new TextDecoder().decode(body.body);

        expect(bodyString).toMatchInlineSnapshot(`"v=1.16.1&c=muswag&f=json&type=alphabeticalByArtist&size=50&u=kkkkk&t=md5%3A123456secretfixed-salt&s=secretfixed-salt"`);

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                "subsonic-response": {
                  status: "ok",
                  version: "1.16.1",
                  albumList2: {
                    album: [{ id: "album-1", name: "First Album", created: "2026-01-01T00:00:00Z", duration: 120, songCount: 1 }],
                  },
                },
              }),
            ),
          ),
        );
      });

      const TestLayer = SubsonicAPILive({
        url: "https://music.k.com",
        auth: {
          username: "kkkkk",
          password: "123456",
        },
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(HttpClient.HttpClient, fakeHttpClient),
            Layer.succeed(
              SubsonicCrypto,
              SubsonicCrypto.of({
                md5: (v) => Effect.succeed("md5:" + v),
                cachedSaltGenerator: () => "secretfixed-salt",
              }),
            ),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        return yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: 50 });
      }).pipe(Effect.provide(TestLayer));

      expect(result).toMatchInlineSnapshot(`
        {
          "albumList2": {
            "album": [
              {
                "created": "2026-01-01T00:00:00Z",
                "duration": 120,
                "id": "album-1",
                "name": "First Album",
                "songCount": 1,
              },
            ],
          },
          "status": "ok",
          "version": "1.16.1",
        }
      `);
    }),
  );

  it.effect("retries two times on network errors", () =>
    Effect.gen(function* () {
      let count = 0;
      const fakeHttpClient = HttpClient.make((request, _) => {
        if (count < 2) {
          count++;
          return Effect.fail(new HttpClientError({ reason: new TransportError({ request, description: "err" }) }));
        }

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                "subsonic-response": {
                  status: "ok",
                  version: "1.16.1",
                  albumList2: {
                    album: [{ id: "album-1", name: "First Album", created: "2026-01-01T00:00:00Z", duration: 120, songCount: 1 }],
                  },
                },
              }),
            ),
          ),
        );
      });

      const TestLayer = SubsonicAPILive({
        url: "https://music.k.com",
        auth: {
          username: "kkkkk",
          password: "123456",
        },
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(HttpClient.HttpClient, fakeHttpClient),
            Layer.succeed(
              SubsonicCrypto,
              SubsonicCrypto.of({
                md5: (v) => Effect.succeed("md5:" + v),
                cachedSaltGenerator: () => "secretfixed-salt",
              }),
            ),
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        return yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: 50 });
      }).pipe(Effect.provide(TestLayer));

      expect(result).toMatchInlineSnapshot(`
        {
          "albumList2": {
            "album": [
              {
                "created": "2026-01-01T00:00:00Z",
                "duration": 120,
                "id": "album-1",
                "name": "First Album",
                "songCount": 1,
              },
            ],
          },
          "status": "ok",
          "version": "1.16.1",
        }
      `);
    }),
  );

  /*
 

  it("keeps Subsonic failures in the typed error channel", async () => {
    const api = await createApi({
      "subsonic-response": {
        status: "failed",
        version: "1.16.1",
        error: { code: 40, message: "Wrong username or password." },
      },
    });

    const exit = await Effect.runPromiseExit(api.ping);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(SubsonicApiError);
      expect(error).toMatchObject({ code: 40, method: "ping", message: "Wrong username or password." });
    }
  });

  it("reports schema failures as typed decode errors", async () => {
    const api = await createApi({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
        albumList2: { album: [{ id: "album-1", name: "Missing required fields" }] },
      },
    });

    const exit = await Effect.runPromiseExit(api.getAlbumList2({ type: "newest" }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(SubsonicDecodeError);
      expect(error).toMatchObject({ method: "getAlbumList2" });
    }
  });
  */
});
