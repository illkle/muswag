import { Cause, Effect, Exit } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { createHash, getRandomValues } from "node:crypto";

import { make, SubsonicApiError, SubsonicDecodeError, type SubsonicApiService, SubsonicCrypto } from "@muswag/subsonic-api/effect";

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

  return Effect.runPromise(
    make({
      url: "https://music.example",
      salt: "fixed-salt",
      reuseSalt: true,
      auth: { username: "alice", password: "secret" },
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(SubsonicCrypto, {
        md5: (v) => Effect.succeed("md5:" + v),
        cachedSaltGenerator: () => "secretfixed-salt",
      }),
    ),
  );
}

describe("Effect SubsonicAPI", () => {
  it("uses the HttpClient service and decodes endpoint responses", async () => {
    const urls: URL[] = [];
    const api = await createApi(
      {
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          albumList2: {
            album: [{ id: "album-1", name: "First Album", created: "2026-01-01T00:00:00Z", duration: 120, songCount: 1 }],
          },
        },
      },
      urls,
    );

    const result = await Effect.runPromise(api.getAlbumList2({ type: "alphabeticalByArtist", size: 50 }));

    expect(result.albumList2.album?.[0]?.name).toBe("First Album");
    expect(urls[0]?.pathname).toBe("/rest/getAlbumList2.view");
    expect(urls[0]?.searchParams.get("u")).toBe("alice");
    expect(urls[0]?.searchParams.get("s")).toBe("fixed-salt");
    expect(urls[0]?.searchParams.get("t")).toBe("md5:secretfixed-salt");
  });

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
});
