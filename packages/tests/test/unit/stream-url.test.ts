import { describe, expect, it } from "vitest";

import { buildSubsonicStreamUrl } from "@muswag/shared";

describe("buildSubsonicStreamUrl", () => {
  it("requests the original bounded stream so mpv can prefetch the next track", () => {
    const url = new URL(buildSubsonicStreamUrl((v) => "somehash", { password: "secret", url: "https://music.example", username: "alice" }, "track-1"));

    expect(url.pathname).toBe("/rest/stream.view");
    expect(url.searchParams.get("id")).toBe("track-1");
    expect(url.searchParams.get("format")).toBe("raw");
    expect(url.searchParams.get("maxBitRate")).toBe("0");
    expect(url.searchParams.get("estimateContentLength")).toBe("true");
  });
});
