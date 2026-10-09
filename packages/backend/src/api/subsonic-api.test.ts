import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Crypto, Effect, Fiber, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";

import { SubsonicAPILive } from "../test/index.js";
import { locateSubsonicServer, SubsonicAPI, type SubsonicApiConfig } from "./subsonic-api.js";
import { HttpClientError, TransportError } from "effect/http/HttpClientError";

const config: SubsonicApiConfig = { url: "https://music.k.com", auth: { username: "kkkkk", password: "123456" } };
const subsonic = (payload: object) => JSON.stringify({ "subsonic-response": { status: "ok", version: "1.16.1", ...payload } });
const failed = (code: number, message: string) => JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code, message } } });
const albumList = { albumList2: { album: [{ id: "album-1", name: "First Album", created: "2026-01-01T00:00:00Z", duration: 120, songCount: 1 }] } };

describe("Effect SubsonicAPI", () => {
  const testCrypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(0xab),
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  const platform = (client: HttpClient.HttpClient) => Layer.merge(Layer.succeed(HttpClient.HttpClient, client), Layer.succeed(Crypto.Crypto, testCrypto));
  const withClient = (client: HttpClient.HttpClient, overrides: Partial<SubsonicApiConfig> = {}) => SubsonicAPILive({ ...config, ...overrides }).pipe(Layer.provide(platform(client)));

  it.effect("correctly makes request to getAlbumList2 and parses result", () =>
    Effect.gen(function* () {
      const fakeHttpClient = HttpClient.make((request, url) => {
        expect(request.method).toBe("POST");
        expect(url.origin).toBe("https://music.k.com");

        const body = request.body;

        if (body._tag !== "Uint8Array") {
          throw new Error(`Unexpected body type: ${body._tag}`);
        }

        const bodyString = new TextDecoder().decode(body.body);

        expect(url.pathname).toBe("/rest/getAlbumList2.view");
        expect(url.toString()).toMatchInlineSnapshot(`"https://music.k.com/rest/getAlbumList2.view"`);

        expect(bodyString).toMatchInlineSnapshot(`"v=1.16.1&c=muswag&f=json&type=alphabeticalByArtist&size=50&u=kkkkk&t=31973b88ed20dce56f7bd58e05c149d7&s=abababababababababababababababab"`);

        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(subsonic(albumList))));
      });

      const result = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        return yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: 50 });
      }).pipe(Effect.provide(withClient(fakeHttpClient)));

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

  it.effect("sends a request that reads again, twice, after a network error", () =>
    Effect.gen(function* () {
      let count = 0;
      const fakeHttpClient = HttpClient.make((request) => {
        count += 1;
        if (count <= 2) return Effect.fail(new HttpClientError({ reason: new TransportError({ request, description: "err" }) }));
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(subsonic(albumList))));
      });

      const result = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        return yield* api.getAlbumList2({ type: "alphabeticalByArtist", size: 50 });
      }).pipe(Effect.provide(withClient(fakeHttpClient)));

      expect(result.albumList2.album).toHaveLength(1);
      expect(count).toBe(3);
    }),
  );

  it.effect("sends a request that changes a playlist once, whatever happens to it", () =>
    Effect.gen(function* () {
      const sent: string[] = [];
      // The server may have applied the request although its answer never arrived.
      const fakeHttpClient = HttpClient.make((request, url) => {
        sent.push(url.pathname);
        return Effect.fail(new HttpClientError({ reason: new TransportError({ request, description: "connection reset" }) }));
      });

      const errors = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        return yield* Effect.all([
          Effect.flip(api.createPlaylist({ name: "Mix", songId: ["a"] })),
          Effect.flip(api.updatePlaylist({ playlistId: "p", songIndexToRemove: [0], songIdToAdd: ["a"] })),
          Effect.flip(api.deletePlaylist({ id: "p" })),
        ]);
      }).pipe(Effect.provide(withClient(fakeHttpClient)));

      expect(errors.map(({ _tag }) => _tag)).toEqual(["HttpClientError", "HttpClientError", "HttpClientError"]);
      expect(sent).toEqual(["/rest/createPlaylist.view", "/rest/updatePlaylist.view", "/rest/deletePlaylist.view"]);
    }),
  );

  it.effect("gives up on a server that does not start answering, without asking it again", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fakeHttpClient = HttpClient.make(() => {
        attempts += 1;
        return Effect.never;
      });

      const error = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        const hanging = yield* Effect.forkChild(Effect.flip(api.getPlaylists));
        yield* TestClock.adjust("29 seconds");
        expect(hanging.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(hanging);
      }).pipe(Effect.provide(withClient(fakeHttpClient)));

      expect(error).toMatchObject({ _tag: "HttpClientError", reason: { _tag: "TransportError" } });
      // One line a user can read, with the address but nothing of the credentials.
      expect(error.message).toBe("Transport: no answer within 30 seconds (POST https://music.k.com/rest/getPlaylists.view)");
      expect(attempts).toBe(1);
    }),
  );

  it.effect("does not time a response out once its headers are in, however long the body takes", () =>
    Effect.gen(function* () {
      let release!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          release = () => {
            controller.enqueue(new TextEncoder().encode(subsonic(albumList)));
            controller.close();
          };
        },
      });
      const fakeHttpClient = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body))));

      const result = yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        const reading = yield* Effect.forkChild(api.getAlbumList2({ type: "alphabeticalByArtist" }));
        yield* TestClock.adjust("5 minutes");
        release();
        return yield* Fiber.join(reading);
      }).pipe(Effect.provide(withClient(fakeHttpClient)));

      expect(result.albumList2.album).toHaveLength(1);
    }),
  );

  it.effect("reports a refused password, and only that", () =>
    Effect.gen(function* () {
      let rejected = 0;
      const answers = [failed(70, "not found"), failed(40, "Wrong username or password")];
      const fakeHttpClient = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(answers.shift()!))));
      const onCredentialsRejected = Effect.sync(() => {
        rejected += 1;
      });

      yield* Effect.gen(function* () {
        const api = yield* SubsonicAPI;
        expect(yield* Effect.flip(api.getPlaylist({ id: "gone" }))).toMatchObject({ _tag: "SubsonicApiError", code: 70 });
        expect(rejected).toBe(0);
        expect(yield* Effect.flip(api.getPlaylists)).toMatchObject({ _tag: "SubsonicApiError", code: 40 });
        expect(rejected).toBe(1);
      }).pipe(Effect.provide(withClient(fakeHttpClient, { onCredentialsRejected })));
    }),
  );
});

describe("locateSubsonicServer", () => {
  const crypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(0xab),
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );

  /** A server on a free loopback port, closed with the test. */
  const listen = (handler: (request: IncomingMessage, body: string, response: ServerResponse) => void) =>
    Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((request, response) => {
          let body = "";
          request.on("data", (chunk) => (body += chunk));
          request.on("end", () => handler(request, body, response));
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.closeAllConnections();
          server.close(() => resume(Effect.void));
        }),
    ).pipe(Effect.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`));

  /** Answers as a Subsonic server does when the request carries its parameters, and as one that got none otherwise. */
  const subsonicServer = (seen: Array<{ method: string | undefined; body: string }>) =>
    listen((request, body, response) => {
      seen.push({ method: request.method, body });
      response.setHeader("content-type", "application/json");
      response.end(new URLSearchParams(body).get("u") === "kkkkk" ? subsonic({}) : failed(10, "required parameter is missing"));
    });

  for (const status of [301, 302, 307]) {
    it.live(`finds a server behind a ${status} redirect, where fetch alone would drop the POST's parameters`, () =>
      Effect.gen(function* () {
        const seen: Array<{ method: string | undefined; body: string }> = [];
        const server = yield* subsonicServer(seen);
        // As a proxy that sends http to https: the same path at another origin.
        const redirecting = yield* listen((request, _body, response) => {
          response.writeHead(status, { location: `${server}/music${request.url}` });
          response.end();
        });

        const located = yield* locateSubsonicServer({ ...config, url: redirecting });

        expect(located).toBe(`${server}/music`);
        expect(seen).toEqual([{ method: "POST", body: expect.stringContaining("u=kkkkk") }]);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(FetchHttpClient.layer, crypto))),
    );
  }

  it.live("does not take the login to another host a redirect names", () =>
    Effect.gen(function* () {
      const seen: Array<{ method: string | undefined; body: string }> = [];
      const server = yield* subsonicServer(seen);
      // The same machine under another name, which is another host as far as the address goes.
      const elsewhere = server.replace("127.0.0.1", "localhost");
      expect(elsewhere).not.toBe(server);
      const redirecting = yield* listen((request, _body, response) => {
        response.writeHead(302, { location: `${elsewhere}${request.url}` });
        response.end();
      });

      const error = yield* Effect.flip(locateSubsonicServer({ ...config, url: redirecting }));

      expect(error).toMatchObject({ _tag: "SubsonicHttpError", status: 302, location: expect.stringContaining("localhost") });
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(FetchHttpClient.layer, crypto))),
  );

  it.live("is what a login needs: without it, fetch turns the redirected POST into a GET with nothing in it", () =>
    Effect.gen(function* () {
      const seen: Array<{ method: string | undefined; body: string }> = [];
      const server = yield* subsonicServer(seen);
      const redirecting = yield* listen((request, _body, response) => {
        response.writeHead(301, { location: `${server}${request.url}` });
        response.end();
      });

      const error = yield* Effect.flip(SubsonicAPI.use((api) => api.ping)).pipe(Effect.provide(SubsonicAPILive({ ...config, url: redirecting })));

      expect(error).toMatchObject({ _tag: "SubsonicApiError", code: 10 });
      expect(seen).toEqual([{ method: "GET", body: "" }]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(FetchHttpClient.layer, crypto))),
  );

  it.effect("answers with the address it was given when the server is there, and stops at a redirect that leads nowhere", () =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const client = HttpClient.make((request, url) => {
        asked.push(url.href);
        if (url.host === "music.k.com") return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(subsonic({}))));
        // Each address redirects to itself with one more folder, for ever.
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 302, headers: { location: `${url.origin}/deeper${url.pathname}` } })));
      });
      const platform = Layer.merge(Layer.succeed(HttpClient.HttpClient, client), crypto);

      expect(yield* locateSubsonicServer(config).pipe(Effect.provide(platform))).toBe("https://music.k.com");
      expect(asked).toEqual(["https://music.k.com/rest/ping.view"]);

      const error = yield* Effect.flip(locateSubsonicServer({ ...config, url: "https://loop.example" })).pipe(Effect.provide(platform));
      expect(error).toMatchObject({ _tag: "SubsonicHttpError", status: 302 });
      expect(asked).toHaveLength(1 + 6);

      const wrong = yield* Effect.flip(
        locateSubsonicServer(config).pipe(
          Effect.provide(
            Layer.merge(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(failed(40, "Wrong username or password"))))),
              ),
              crypto,
            ),
          ),
        ),
      );
      expect(wrong).toMatchObject({ _tag: "SubsonicApiError", code: 40 });
    }),
  );
});
