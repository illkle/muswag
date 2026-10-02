import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { runCommand as run } from "./exec";
const runCommand = (...args: Parameters<typeof run>) => run(...args).pipe(Effect.provide(NodeServices.layer));

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
