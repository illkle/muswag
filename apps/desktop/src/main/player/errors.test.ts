import { describe, expect, it } from "vitest";
import { BinaryUnavailable, describeFailure, EngineError, NotAuthenticated, PlaybackFailed, safeFailure } from "./errors";

describe("safe log context", () => {
  it("never includes unknown native causes or signed URLs", () => {
    const secret = "https://music.test/stream?password=hunter2";
    expect(JSON.stringify(safeFailure(new Error(secret, { cause: { password: secret } })))).not.toContain(secret);
    expect(safeFailure(new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }))).toEqual({ tag: "EngineError", reason: "timeout", operation: "loadfile" });
  });
});

describe("failures as the user is told about them", () => {
  it("say what there is to fix, and never what mpv was asked", () => {
    expect(describeFailure(new NotAuthenticated({ operation: "playback", message: "Log in." }))).toEqual({ message: "Log in.", fix: "login" });
    expect(describeFailure(new BinaryUnavailable({ operation: "playback", message: "mpv was not found." }))).toEqual({ message: "mpv was not found.", fix: "mpv" });
    expect(describeFailure(new PlaybackFailed({ operation: "load", message: "The track did not finish loading." }))).toEqual({ message: "The track did not finish loading.", fix: null });
    expect(describeFailure(new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }))).toEqual({ message: "The playback engine did not respond in time.", fix: null });
  });
});
