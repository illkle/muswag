import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { locateSubsonicServer, SubsonicAPI, subsonicToken, WRONG_CREDENTIALS } from "@muswag/backend";
import { SubsonicAPILive } from "@muswag/backend/testing";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, expect, it } from "vitest";

import { forEachServer, type Account, type TestServer } from "./servers/index.js";

/** The configuration the app makes of what the user types into the login form. */
function loginConfig(url: string, account: Account) {
  const salt = randomBytes(16).toString("hex");
  return { url, auth: { username: account.username, salt, token: subsonicToken(account.password, salt) } };
}

/** Pings `server` as `account` and answers with the error, if any, and whether muswag took the credentials for refused. */
async function ping(server: TestServer, account: Account) {
  let rejected = false;
  const onCredentialsRejected = Effect.sync(() => {
    rejected = true;
  });
  const layer = SubsonicAPILive({ ...loginConfig(server.url, account), onCredentialsRejected }).pipe(Layer.provide(FetchHttpClient.layer));
  const error = await Effect.runPromise(SubsonicAPI.use((api) => api.ping).pipe(Effect.flip, Effect.provide(layer)));
  return { error, rejected };
}

forEachServer((server) => {
  let proxy: Server | undefined;
  afterEach(() => {
    proxy?.close();
    proxy = undefined;
  });

  it("finds the server at the address the user typed", async () => {
    const url = await Effect.runPromise(locateSubsonicServer(loginConfig(server().url, server().admin)).pipe(Effect.provide(FetchHttpClient.layer)));
    expect(url).toBe(server().url);
  });

  it("follows the server to where an address of the same host redirects", async () => {
    // A proxy in front of the server that sends every request on to it, as one moving http to https would.
    proxy = createServer((request, response) => {
      response.writeHead(301, { location: `${server().url}${request.url}` }).end();
    });
    const { hostname } = new URL(server().url);
    await new Promise<void>((resolve) => proxy!.listen(0, hostname, resolve));
    const typed = `http://${hostname}:${(proxy.address() as AddressInfo).port}`;

    const url = await Effect.runPromise(locateSubsonicServer(loginConfig(typed, server().admin)).pipe(Effect.provide(FetchHttpClient.layer)));
    expect(url).toBe(server().url);
  });

  it("takes a wrong password, and an unknown user, for refused credentials", async () => {
    for (const account of [
      { username: server().admin.username, password: "not the password" },
      { username: "nobody", password: "whatever" },
    ]) {
      const { error, rejected } = await ping(server(), account);
      // The server names itself, which the login form needs to say what LMS wants in place of a password.
      expect(error).toMatchObject({ _tag: "SubsonicApiError", code: WRONG_CREDENTIALS, server: server().name });
      expect(rejected).toBe(true);
    }
  });
});
