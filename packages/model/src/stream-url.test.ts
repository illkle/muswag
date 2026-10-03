import { describe, expect, it } from "vitest";

import { buildSubsonicStreamUrl } from "./helpers.js";

const credentials = { password: "secret", url: "https://music.example", username: "alice" };

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
