import { describe, expect, it } from "vitest";
import { EngineError, NotAuthenticated, safeFailure, toIssue } from "./errors";

describe("safe log context", () => {
  it("never includes unknown native causes or signed URLs", () => {
    const secret = "https://music.test/stream?password=hunter2";
    expect(JSON.stringify(safeFailure(new Error(secret, { cause: { password: secret } })))).not.toContain(secret);
    expect(safeFailure(new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }))).toEqual({ tag: "EngineError", reason: "timeout", operation: "loadfile" });
  });
});

describe("issues", () => {
  it("derive their code and actions from the error tag", () => {
    expect(toIssue(new NotAuthenticated({ operation: "playback", message: "Log in." }))).toMatchObject({ code: "NotAuthenticated", operation: "playback", actions: ["login"] });
    expect(toIssue(new EngineError({ reason: "rejected", operation: "seek", uncertain: false }), "Seek", "a")).toMatchObject({ code: "CommandRejected", operation: "Seek", occurrenceKey: "a" });
  });
});
