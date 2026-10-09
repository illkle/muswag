import { it } from "@effect/vitest";
import { albums, credentials, playlists, songs, type SessionCredentials } from "@muswag/model";
import { Crypto, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { layer as PathLayer } from "effect/Path";
import { TestClock } from "effect/testing";
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

type Answer = Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

function makeLayer(
  options: {
    removed?: string[];
    cipher?: CredentialsCipher;
    playlistsGate?: Promise<void>;
    requested?: string[];
    /** Answers in place of the server, for the requests it returns something for. */
    answer?: (url: URL, respond: (response: Response) => Answer, fail: (cause: unknown) => Answer) => Answer | undefined;
  } = {},
) {
  let pingCalls = 0;
  const crypto = Crypto.make({
    randomBytes: (size) => new Uint8Array(size).fill(0xab),
    digest: (_algorithm, data) => Effect.succeed(data),
  });
  const http = HttpClient.make((request, url) => {
    if (url.pathname === "/rest/ping.view") pingCalls += 1;
    options.requested?.push(url.pathname);
    const answer = options.answer?.(
      url,
      (response) => Effect.succeed(HttpClientResponse.fromWeb(request, response)),
      (cause) => Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) })),
    );
    if (answer) return answer;
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
      exists: () => Effect.succeed(false),
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

      const failed = yield* Effect.flip(manager.login({ ...goodCredentials, username: "bad" }));
      expect(pingCalls()).toBe(2);
      expect(failed).toMatchObject({ _tag: "SessionError", operation: "login" });
      expect(yield* storedCredentials).toEqual([{ id: 1, ...goodCredentials, encrypted: false }]);
      expect(yield* manager.credentials).toEqual(goodCredentials);
      expect(yield* manager.snapshot).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });

      expect(yield* manager.logout).toEqual({ _tag: "LoggedOut" });
      expect(yield* storedCredentials).toEqual([]);
      expect(yield* manager.credentials).toBeNull();
      expect(yield* Effect.flip(manager.use(() => Effect.void))).toMatchObject({ _tag: "NotAuthenticated" });

      yield* manager.login(goodCredentials);
      expect(yield* manager.restore).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "alice" });
      expect(pingCalls()).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.live("starts a library sync with each session, and reports how it went in the sync's status", () => {
    const requested: string[] = [];
    const { layer } = makeLayer({ requested });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      const status = yield* manager.use(({ library }) =>
        library.changes.pipe(
          Stream.filter(({ running, error }) => running === null && error !== null),
          Stream.runHead,
        ),
      );

      // The server of this test answers with nothing to sync, which the sync reports and login does not.
      expect(requested).toContain("/rest/getIndexes.view");
      expect(Option.getOrThrow(status).error).toEqual(expect.any(String));
      expect(yield* manager.snapshot).toMatchObject({ _tag: "LoggedIn" });
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

  it.effect("deletes the library, playlists and the cover directory on logout", () => {
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
      // The first login found no account to keep the data of, and cleared what was there.
      removed.length = 0;

      yield* manager.logout;

      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
      expect(yield* idsOf(playlists)).toEqual([]);
      expect(removed).toEqual(["covers"]);
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

  it.effect("says why a login failed, without the credentials", () => {
    const { layer } = makeLayer({
      answer: (url, respond, fail) => {
        if (url.host === "down.example") return fail(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND down.example") }));
        if (url.host === "slow.example") return Effect.never;
        if (url.host === "web.example") return respond(new Response("<html>Welcome</html>", { headers: { "content-type": "text/html" } }));
        if (url.host === "other.example") return respond(new Response("Not found", { status: 404 }));
        if (url.host === "old.example")
          return respond(new Response(JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code: 41, message: "Token authentication not supported" } } })));
        return undefined;
      },
    });
    const secret = { username: "alice-the-user", password: "a-secret-password" };

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      const failure = (url: string, username = secret.username) => Effect.flip(manager.login({ ...secret, url, username })).pipe(Effect.map(({ message }) => message));

      const slow = yield* Effect.forkChild(failure("https://slow.example"));
      yield* TestClock.adjust("30 seconds");

      const messages = {
        password: yield* failure("https://music.example", "bad"),
        address: yield* failure("ftp://music.example"),
        unreachable: yield* failure("https://down.example"),
        slow: yield* Fiber.join(slow),
        page: yield* failure("https://web.example"),
        missing: yield* failure("https://other.example/navidrome"),
        refused: yield* failure("https://old.example"),
      };

      expect(messages).toEqual({
        password: "Wrong username or password",
        address: "The server address is not a valid http or https address",
        unreachable: "The server could not be reached: getaddrinfo ENOTFOUND down.example",
        slow: "The server could not be reached: no answer within 30 seconds",
        page: "This address does not answer like a Subsonic server",
        missing: "This address does not answer like a Subsonic server (HTTP 404)",
        refused: "The server refused the login: Token authentication not supported",
      });
      for (const message of Object.values(messages)) {
        expect(message).not.toContain(secret.password);
        expect(message).not.toContain(secret.username);
      }
      expect(yield* manager.snapshot).toEqual({ _tag: "Initializing" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("stores one form of the address, which is where a redirect of the login leads", () => {
    const requested: string[] = [];
    const { layer } = makeLayer({
      // As a proxy that sends http to https.
      answer: (url, respond) => {
        requested.push(url.href);
        return url.protocol === "http:" ? respond(new Response(null, { status: 301, headers: { location: `https://${url.host}${url.pathname}` } })) : undefined;
      },
    });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;

      expect(yield* manager.login({ ...goodCredentials, url: "HTTP://Music.Example/navidrome/rest/" })).toEqual({ _tag: "LoggedIn", url: "https://music.example/navidrome", username: "alice" });
      expect(requested.slice(0, 2)).toEqual(["http://music.example/navidrome/rest/ping.view", "https://music.example/navidrome/rest/ping.view"]);
      expect((yield* storedCredentials)[0]?.url).toBe("https://music.example/navidrome");
      // Every later request goes to where the server is.
      expect(requested.slice(2).every((url) => url.startsWith("https://music.example/navidrome/rest/"))).toBe(true);
      expect((yield* manager.credentials)?.url).toBe("https://music.example/navidrome");
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes what another account left on login, and keeps what the same account left", () => {
    const removed: string[] = [];
    let keychainLost = false;
    const cipher: CredentialsCipher = {
      ...reversingCipher,
      decrypt: (encrypted) => {
        if (keychainLost) throw new Error("The keychain has no key for this");
        return reversingCipher.decrypt(encrypted);
      },
    };
    const { layer } = makeLayer({ removed, cipher });
    const library = { albums: [apiAlbum("a1")], songs: [apiSong("s1", "a1")] };
    let deletions = 0;
    const beforeDataIsDeleted = Effect.sync(() => {
      deletions += 1;
    });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      yield* seed(library);
      removed.length = 0;

      // The stored password can no longer be read, so the app starts at the login form with the data still there.
      keychainLost = true;
      expect(yield* manager.restore).toEqual({ _tag: "LoggedOut" });
      expect(yield* idsOf(albums)).toEqual(["a1"]);

      // The same server and user, spelled another way: the data is theirs.
      yield* manager.login({ ...goodCredentials, url: "https://MUSIC.example/" }, { beforeDataIsDeleted });
      expect(yield* idsOf(albums)).toEqual(["a1"]);
      expect([deletions, removed]).toEqual([0, []]);

      // A login that fails deletes nothing either.
      yield* Effect.flip(manager.login({ ...goodCredentials, username: "bad" }, { beforeDataIsDeleted }));
      expect(yield* idsOf(albums)).toEqual(["a1"]);

      yield* manager.login({ ...goodCredentials, username: "carol" }, { beforeDataIsDeleted });
      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* idsOf(songs)).toEqual([]);
      expect([deletions, removed]).toEqual([1, ["covers"]]);
      expect(yield* manager.snapshot).toEqual({ _tag: "LoggedIn", url: goodCredentials.url, username: "carol" });

      // Another server with the same user name is another account too.
      yield* seed(library);
      yield* manager.login({ ...goodCredentials, url: "https://other.example", username: "carol" }, { beforeDataIsDeleted });
      expect(yield* idsOf(albums)).toEqual([]);
      expect(deletions).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not end a session over one refusal that the server does not repeat", () => {
    let refusals = 1;
    const { layer } = makeLayer({
      // As a server answers when its own lookup of the user fails for a moment.
      answer: (url, respond) =>
        url.pathname === "/rest/getPlaylists.view" && refusals-- > 0
          ? respond(new Response(JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code: 40, message: "Wrong username or password" } } })))
          : undefined,
    });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      yield* manager.use(({ playlists }) => playlists.sync);
      yield* Effect.sleep("50 millis");

      expect(yield* manager.snapshot).toMatchObject({ _tag: "LoggedIn" });
      expect(yield* storedCredentials).toEqual([{ id: 1, ...goodCredentials, encrypted: false }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("forgets the account before, when the login that replaced it cannot be stored", () => {
    let failing = false;
    const cipher: CredentialsCipher = {
      ...reversingCipher,
      encrypt: (plain) => {
        if (failing) throw new Error("keychain is locked");
        return reversingCipher.encrypt(plain);
      },
    };
    const { layer } = makeLayer({ cipher });

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      yield* seed({ albums: [apiAlbum("a1")] });

      failing = true;
      expect(Exit.isFailure(yield* Effect.exit(manager.login({ ...goodCredentials, username: "carol" })))).toBe(true);

      // alice's library is gone, so alice must not be who the next start restores.
      expect(yield* idsOf(albums)).toEqual([]);
      expect(yield* storedCredentials).toEqual([]);
      expect(yield* manager.restore).toEqual({ _tag: "LoggedOut" });
    }).pipe(Effect.provide(layer));
  });

  it.live("ends a session whose password the server refuses, and keeps its data for the next login", () => {
    const requested: string[] = [];
    let refused = false;
    const { layer } = makeLayer({
      requested,
      answer: (_url, respond) =>
        refused ? respond(new Response(JSON.stringify({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code: 40, message: "Wrong username or password" } } }))) : undefined,
    });
    const expired = { _tag: "LoggedOut", expired: { url: goodCredentials.url, username: "alice" } };

    return Effect.gen(function* () {
      const manager = yield* SessionManager;
      yield* manager.login(goodCredentials);
      yield* seed({ albums: [apiAlbum("a1")], songs: [apiSong("s1", "a1")] });

      // The password is changed on the server; the next request of the session is how the app learns of it.
      refused = true;
      const ended = yield* manager.changes.pipe(
        Stream.filter((snapshot) => snapshot._tag === "LoggedOut"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* manager.use(({ playlists }) => playlists.sync);

      expect(Option.getOrThrow(yield* Fiber.join(ended))).toEqual(expired);
      expect(yield* manager.credentials).toBeNull();
      expect(yield* Effect.flip(manager.use(() => Effect.void))).toMatchObject({ _tag: "NotAuthenticated" });
      // The library stays, and so does whose it is, without the password that no longer works.
      expect(yield* idsOf(albums)).toEqual(["a1"]);
      expect(yield* storedCredentials).toEqual([{ id: 1, url: goodCredentials.url, username: "alice", password: "", encrypted: false }]);

      // The next start asks the server nothing and says the same.
      requested.length = 0;
      expect(yield* manager.restore).toEqual(expired);
      expect(requested).toEqual([]);

      refused = false;
      yield* manager.login({ ...goodCredentials, password: "new-secret" });
      expect(yield* idsOf(albums)).toEqual(["a1"]);
      expect(yield* manager.credentials).toEqual({ ...goodCredentials, password: "new-secret" });
    }).pipe(Effect.provide(layer));
  });
});
