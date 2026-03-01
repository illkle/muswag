import { describe, expect, it } from "vitest";

import { buildAuthQueryParams, createSubsonicToken } from "../../src/navidrome/auth.js";

describe("auth query params", () => {
  it("builds query token auth parameters and never uses apiKey", () => {
    const salt = "abc123salt";
    const params = buildAuthQueryParams(
      {
        baseUrl: "http://127.0.0.1:4533",
        username: "alice",
        password: "secret",
        clientName: "muswag-test",
        protocolVersion: "1.16.1"
      },
      salt
    );

    expect(params.get("u")).toBe("alice");
    expect(params.get("s")).toBe(salt);
    expect(params.get("v")).toBe("1.16.1");
    expect(params.get("c")).toBe("muswag-test");
    expect(params.get("f")).toBe("json");
    expect(params.get("t")).toBe(createSubsonicToken("secret", salt));
    expect(params.get("apiKey")).toBeNull();
  });
});
