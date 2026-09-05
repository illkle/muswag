import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SerialQueue } from "#shared/serial-queue";
import { runCommand } from "./exec";

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

describe("runCommand", () => {
  it("captures stdout, stderr, exit codes, and spawn failures", async () => {
    await expect(Effect.runPromise(runCommand(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(2)"]))).resolves.toEqual({
      code: 2,
      errorCode: null,
      stderr: "err",
      stdout: "out",
    });
    const missing = await Effect.runPromise(runCommand(join(tmpdir(), "definitely-missing-muswag-command"), []));
    expect(missing).toMatchObject({ code: null, errorCode: "ENOENT" });
  });

  it("reports timeouts", async () => {
    const result = await Effect.runPromise(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10 }));
    expect(result).toMatchObject({ code: null, errorCode: "ETIMEDOUT" });
  });
});
