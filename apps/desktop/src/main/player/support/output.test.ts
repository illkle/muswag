import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { installationLines } from "./output";

describe("installation output", () => {
  it("frames split URLs, flushes the last line, and bounds unterminated output", async () => {
    const bytes = new TextEncoder();
    const lines = await Effect.runPromise(
      installationLines(Stream.make(bytes.encode("fetch https://music.test/"), bytes.encode("secret?password=hidden\r\n"), bytes.encode("x".repeat(9000)), bytes.encode("\nfinished"))).pipe(
        Stream.runCollect,
      ),
    );
    expect(lines).toEqual(["fetch [url]", "[output line exceeded 8192 characters]", "finished"]);
  });
});
