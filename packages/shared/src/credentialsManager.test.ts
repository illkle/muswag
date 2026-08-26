import { it } from "@effect/vitest";
import { Crypto, Effect, Layer } from "effect";
import { layer as PathLayer } from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vitest";

import { CredentialsStore, MiniFs, MuswagDatabase, SessionManager, SessionManagerLive, type SessionCredentials } from "./index.js";
import { createInMemoryDb } from "./test/database.js";

const goodCredentials: SessionCredentials = {
  url: "https://music.example",
  username: "alice",
  password: "secret",
};

describe("SessionManager", () => {
  it.effect("restores, replaces, and releases authenticated services atomically", () => {
    const db = createInMemoryDb();
    let stored: SessionCredentials | null = null;
    let pingCalls = 0;
    const crypto = Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(0xab),
      digest: (_algorithm, data) => Effect.succeed(data),
    });
    const http = HttpClient.make((request, url) => {
      if (url.pathname === "/rest/ping.view") pingCalls += 1;
      const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const username = new URLSearchParams(body).get("u");
      const failed = username === "bad";
      const payload =
        url.pathname === "/rest/getPlaylists.view"
          ? { "subsonic-response": { status: "ok", version: "1.16.1", playlists: {} } }
          : { "subsonic-response": { status: failed ? "failed" : "ok", version: "1.16.1", ...(failed ? { error: { code: 40, message: "bad credentials" } } : {}) } };
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload))));
    });

    const dependencies = Layer.mergeAll(
      Layer.succeed(MuswagDatabase, db),
      Layer.succeed(MiniFs, { writeFile: () => Effect.void, remove: () => Effect.void }),
      Layer.succeed(CredentialsStore, {
        load: Effect.sync(() => stored),
        save: (credentials) =>
          Effect.sync(() => {
            stored = credentials;
          }),
        clear: Effect.sync(() => {
          stored = null;
        }),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(Crypto.Crypto, crypto),
      PathLayer,
    );
    const layer = SessionManagerLive({ coverSaveLocation: "covers" }).pipe(Layer.provide(dependencies));

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      expect(yield* manager.restore).toEqual({ _tag: "LoggedOut" });

      expect(yield* manager.login(goodCredentials)).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });
      expect(pingCalls).toBe(1);
      expect(stored).toEqual(goodCredentials);
      expect(yield* manager.use(({ api }) => Effect.succeed(api.username))).toBe("alice");

      const failed = yield* Effect.flip(manager.login({ ...goodCredentials, username: "bad" }));
      expect(pingCalls).toBe(2);
      expect(failed).toMatchObject({ _tag: "SessionError", operation: "login" });
      expect(stored).toEqual(goodCredentials);
      expect(yield* manager.use(({ api }) => Effect.succeed(api.username))).toBe("alice");

      expect(yield* manager.logout).toEqual({ _tag: "LoggedOut" });
      expect(stored).toBeNull();
      expect(yield* Effect.flip(manager.use(() => Effect.void))).toMatchObject({ _tag: "NotAuthenticated" });

      stored = goodCredentials;
      expect(yield* manager.restore).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });
      expect(pingCalls).toBe(2);
    }).pipe(Effect.provide(layer));
  });
});
