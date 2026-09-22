import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";
import { installationLines } from "./output";

describe("installation output", () => {
  it.effect("frames split URLs, flushes the last line, and bounds unterminated output", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder();
      const chunks = Stream.make(bytes.encode("fetch https://music.test/"), bytes.encode("secret?password=hidden\r\n"), bytes.encode("x".repeat(9000)), bytes.encode("\nfinished"));
      expect(yield* installationLines(chunks).pipe(Stream.runCollect)).toEqual(["fetch [url]", "[output line exceeded 8192 characters]", "finished"]);
    }),
  );
});
