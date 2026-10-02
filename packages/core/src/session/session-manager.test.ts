import { it } from "@effect/vitest";
import { albums, covers, credentials, playlists, songs, type SessionCredentials } from "@muswag/shared";
import { Crypto, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { layer as PathLayer } from "effect/Path";
import { describe, expect } from "vitest";

import { MiniFs } from "../covers/cover-manager.js";
import { Db } from "../db/database.js";
import { PlaylistEdits } from "../playlists/commands.js";
import { apiAlbum, apiSong, idsOf, seed, TestDatabase } from "../test/index.js";
import { CredentialsStoreSql, type CredentialsCipher } from "./credentials-store.js";
import { SessionManager, SessionManagerLive } from "./session-manager.js";

const goodCredentials: SessionCredentials = {
  url: "https://music.example",
  username: "alice",
  password: "secret",
};

const reversingCipher: CredentialsCipher = {
  isAvailable: () => true,
  encrypt: (plain) => [...plain].reverse().join(""),
  decrypt: (encrypted) => [...encrypted].reverse().join(""),
};

function makeLayer(options: { removed?: string[]; cipher?: CredentialsCipher; playlistsGate?: Promise<void> } = {}) {
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
    const remote = { id: "srv1", name: "Remote", songCount: 0, duration: 0, created: "2026-01-01T00:00:00Z", changed: "2026-01-01T00:00:00Z" };
    if (url.pathname === "/rest/getPlaylists.view") {
      const payload = { "subsonic-response": { status: "ok", version: "1.16.1", playlists: options.playlistsGate ? { playlist: [remote] } : {} } };
      return Effect.promise(() => options.playlistsGate ?? Promise.resolve()).pipe(Effect.as(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload)))));
    }
    const payload =
      url.pathname === "/rest/getPlaylist.view"
        ? { "subsonic-response": { status: "ok", version: "1.16.1", playlist: { ...remote, entry: [] } } }
        : { "subsonic-response": { status: failed ? "failed" : "ok", version: "1.16.1", ...(failed ? { error: { code: 40, message: "bad credentials" } } : {}) } };
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(payload))));
  });

  const dependencies = Layer.mergeAll(
    Layer.succeed(MiniFs, {
      writeFile: () => Effect.void,
      remove: (path) =>
        Effect.sync(() => {
          options.removed?.push(path);
        }),
    }),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(Crypto.Crypto, crypto),
    PathLayer,
    PlaylistEdits.layer,
  );
  const layer = SessionManagerLive({ coverSaveLocation: "covers" }).pipe(Layer.provideMerge(CredentialsStoreSql(options.cipher)), Layer.provideMerge(dependencies), Layer.provideMerge(TestDatabase()));
  return { layer, pingCalls: () => pingCalls };
}

const storedCredentials = Db.use((db) => db.select().from(credentials));

describe("SessionManager", () => {
  it.effect("restores, replaces, and releases authenticated services atomically", () => {
    const { layer, pingCalls } = makeLayer();

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      expect(yield* manager.restore).toEqual({ _tag: "LoggedOut" });
      expect(yield* manager.credentials).toBeNull();

      expect(yield* manager.login(goodCredentials)).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });
      expect(pingCalls()).toBe(1);
      expect(yield* storedCredentials).toEqual([{ id: 1, ...goodCredentials, encrypted: false }]);
      expect(yield* manager.credentials).toEqual(goodCredentials);
      expect(yield* manager.use(({ api }) => Effect.succeed(api.username))).toBe("alice");

      const failed = yield* Effect.flip(manager.login({ ...goodCredentials, username: "bad" }));
      expect(pingCalls()).toBe(2);
      expect(failed).toMatchObject({ _tag: "SessionError", operation: "login" });
      expect(yield* storedCredentials).toEqual([{ id: 1, ...goodCredentials, encrypted: false }]);
      expect(yield* manager.use(({ api }) => Effect.succeed(api.username))).toBe("alice");

      expect(yield* manager.logout).toEqual({ _tag: "LoggedOut" });
      expect(yield* storedCredentials).toEqual([]);
      expect(yield* manager.credentials).toBeNull();
      expect(yield* Effect.flip(manager.use(() => Effect.void))).toMatchObject({ _tag: "NotAuthenticated" });

      yield* manager.login(goodCredentials);
      expect(yield* manager.restore).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });
      expect(pingCalls()).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("encrypts the stored password when a cipher is available", () => {
    const { layer } = makeLayer({ cipher: reversingCipher });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);

      expect(yield* storedCredentials).toEqual([{ id: 1, ...goodCredentials, password: "terces", encrypted: true }]);
      expect(yield* manager.restore).toMatchObject({ _tag: "LoggedIn" });
      expect(yield* manager.credentials).toEqual(goodCredentials);
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes the library, playlists and cover files on logout", () => {
    const removed: string[] = [];
    const { layer } = makeLayer({ removed });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      yield* seed({
        albums: [apiAlbum("a1")],
        songs: [apiSong("s1", "a1")],
        playlists: [{ id: "p1", serverId: null, base: null, local: { name: "P", comment: "", public: false, readonly: false, entries: [] }, revision: 0 }],
      });
      const db = yield* Db;
      yield* db.insert(covers).values({ key: "album:a1:c1", fileName: "album:a1:c1.jpg" });

      yield* manager.logout;

      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
      expect(yield* idsOf(playlists)).toEqual([]);
      expect(yield* db.select().from(covers)).toEqual([]);
      expect(removed).toEqual(["covers/album:a1:c1.jpg"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("stops the session's services on logout, so a running sync cannot write again", () => {
    let release!: () => void;
    const playlistsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { layer } = makeLayer({ playlistsGate });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      // The playlist manager's startup sync is now waiting on the server.
      yield* Effect.sleep("50 millis");

      yield* manager.logout;
      release();
      yield* Effect.sleep("100 millis");

      expect(yield* idsOf(playlists)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
