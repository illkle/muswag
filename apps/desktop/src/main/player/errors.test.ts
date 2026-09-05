import { describe, expect, it } from "vitest";
import { EngineError, safeFailure } from "./errors";

describe("safe log context", () => {
  it("never includes unknown native causes or signed URLs", () => {
    const secret = "https://music.test/stream?password=hunter2";
    expect(JSON.stringify(safeFailure(new Error(secret, { cause: { password: secret } })))).not.toContain(secret);
    expect(safeFailure(new EngineError({ reason: "timeout", operation: "loadfile", uncertain: true }))).toEqual({ tag: "EngineError", reason: "timeout", operation: "loadfile" });
  });
});
