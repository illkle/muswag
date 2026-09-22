import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { loadEnvironmentFile, signalExitCode, stopChildProcess, waitForTerminationSignal } from "./process-lifecycle.ts";
import { RunnerError } from "./runner-error.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const environmentFile = resolve(desktopDirectory, "../../.env");
const electronModule: unknown = createRequire(import.meta.url)("electron");

if (typeof electronModule !== "string") throw new TypeError("Electron did not resolve to its executable path");

const runElectron = Effect.scoped(
  Effect.gen(function* () {
    yield* loadEnvironmentFile(environmentFile);

    const childEnvironment: Record<string, string | undefined> = { ...process.env };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;

    const electron = ChildProcess.make(electronModule, [desktopDirectory], {
      cwd: desktopDirectory,
      detached: false,
      env: childEnvironment,
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
    const handle = yield* electron;
    yield* Effect.addFinalizer(() => stopChildProcess(handle, "Electron"));

    const outcome = yield* Effect.raceFirst(
      handle.exitCode.pipe(Effect.map((code) => ({ _tag: "Exit" as const, code }))),
      waitForTerminationSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
    );

    if (outcome._tag === "Signal") return signalExitCode(outcome.signal);
    if (outcome.code !== 0) {
      return yield* new RunnerError({ message: `Electron exited with code ${outcome.code}`, cause: outcome.code });
    }
    return 0;
  }),
);

process.exitCode = await Effect.runPromise(runElectron.pipe(Effect.provide(NodeServices.layer)));
