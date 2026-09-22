import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SerialQueue } from "#shared/serial-queue";
import { runCommand as run } from "./exec";
const runCommand = (...args: Parameters<typeof run>) => run(...args).pipe(Effect.provide(NodeServices.layer));

describe("SerialQueue", () => {
  it("serializes operations, returns their results, and survives rejection", async () => {
    const queue = new SerialQueue();
    const markers: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      markers.push("first:start");
      await gate;
      markers.push("first:end");
      return 1;
    });
    const second = queue.run(async () => {
      markers.push("second");
      throw new Error("nope");
    });
    const third = queue.run(async () => {
      markers.push("third");
      return 3;
    });
    await Promise.resolve();
    expect(markers).toEqual(["first:start"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("nope");
    await expect(third).resolves.toBe(3);
    expect(markers).toEqual(["first:start", "first:end", "second", "third"]);
  });
});

// Real processes and timeouts need the live clock.
describe("runCommand", () => {
  effectIt.live("captures stdout, stderr, exit codes, and spawn failures", () =>
    Effect.gen(function* () {
      expect(yield* runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(2)"])).toEqual({
        code: 2,
        errorCode: null,
        stderr: "err",
        stdout: "out",
      });
      expect(yield* runCommand(join(tmpdir(), "definitely-missing-muswag-command"), [])).toMatchObject({ code: null, errorCode: "ENOENT" });
    }),
  );

  effectIt.live("reports timeouts", () =>
    Effect.gen(function* () {
      expect(yield* runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10 })).toMatchObject({ code: null, errorCode: "ETIMEDOUT" });
    }),
  );
});
