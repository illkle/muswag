import { describe, expect, it } from "vitest";

import { buildSubsonicStreamUrl, normalizeServerUrl, subsonicRestUrl } from "./helpers.js";

const credentials = { password: "secret", url: "https://music.example", username: "alice" };

describe("normalizeServerUrl", () => {
  it("gives every spelling of an address one form", () => {
    expect(normalizeServerUrl("https://music.example")).toBe("https://music.example");
    expect(normalizeServerUrl("HTTP://Music.Example")).toBe("http://music.example");
    expect(normalizeServerUrl("  https://music.example/// ")).toBe("https://music.example");
    expect(normalizeServerUrl("music.example:4533")).toBe("https://music.example:4533");
    expect(normalizeServerUrl("https://music.example/navidrome/")).toBe("https://music.example/navidrome");
    expect(normalizeServerUrl("https://music.example/?x=1#top")).toBe("https://music.example");
  });

  it("takes the API's address for the server's, but not a path that only ends in the same letters", () => {
    expect(normalizeServerUrl("https://music.example/rest")).toBe("https://music.example");
    expect(normalizeServerUrl("https://music.example/navidrome/rest/")).toBe("https://music.example/navidrome");
    expect(normalizeServerUrl("https://music.example/forest")).toBe("https://music.example/forest");
    expect(normalizeServerUrl("https://music.example/forest/")).toBe("https://music.example/forest");
  });

  it("is settled after one pass", () => {
    for (const address of ["HTTP://Music.Example/", "music.example/navidrome/rest/", "https://music.example/forest", "http://127.0.0.1:4533"]) {
      const once = normalizeServerUrl(address)!;
      expect(normalizeServerUrl(once)).toBe(once);
    }
  });

  it("refuses what is not an http(s) address", () => {
    for (const address of ["", "   ", "ftp://music.example", "file:///etc/passwd", "https://", "http://exa mple"]) {
      expect(normalizeServerUrl(address)).toBeNull();
    }
  });
});

describe("subsonicRestUrl", () => {
  it("is the same place for the API client and for stream URLs", () => {
    for (const [address, rest] of [
      ["HTTP://Music.Example", "http://music.example/rest/"],
      ["https://music.example/", "https://music.example/rest/"],
      ["https://music.example/navidrome", "https://music.example/navidrome/rest/"],
      ["https://music.example/navidrome/rest", "https://music.example/navidrome/rest/"],
      ["https://music.example/forest", "https://music.example/forest/rest/"],
    ] as const) {
      const url = normalizeServerUrl(address)!;
      expect(subsonicRestUrl(url)).toBe(rest);
      expect(buildSubsonicStreamUrl((_v) => "somehash", { ...credentials, url }, "track-1", "salt").split("?")[0]).toBe(`${rest}stream.view`);
    }
  });
});

describe("buildSubsonicStreamUrl", () => {
  it("requests the original bounded stream so mpv can prefetch the next track", () => {
    const url = new URL(buildSubsonicStreamUrl((_v) => "somehash", credentials, "track-1", "salt"));

    expect(url.pathname).toBe("/rest/stream.view");
    expect(url.searchParams.get("id")).toBe("track-1");
    expect(url.searchParams.get("format")).toBe("raw");
    expect(url.searchParams.get("maxBitRate")).toBe("0");
    expect(url.searchParams.get("estimateContentLength")).toBe("true");
  });
  it("signs with the given salt, so a track keeps its URL", () => {
    const build = () => buildSubsonicStreamUrl((value) => `md5(${value})`, credentials, "track-1", "salt");
    const url = new URL(build());

    expect(url.searchParams.get("s")).toBe("salt");
    expect(url.searchParams.get("t")).toBe("md5(secretsalt)");
    expect(build()).toBe(url.toString());
  });
});
