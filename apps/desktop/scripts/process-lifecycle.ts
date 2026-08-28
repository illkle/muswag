import { Effect, FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { RunnerError } from "./runner-error.ts";

export type TerminationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

const terminationSignals: ReadonlyArray<TerminationSignal> = ["SIGHUP", "SIGINT", "SIGTERM"];

export const waitForTerminationSignal = Effect.callback<TerminationSignal>((resume) => {
  const handlers = new Map<TerminationSignal, () => void>();

  const removeHandlers = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };

  for (const signal of terminationSignals) {
    const handler = (): void => {
      removeHandlers();
      resume(Effect.succeed(signal));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }

  return Effect.sync(removeHandlers);
});

export function signalExitCode(signal: TerminationSignal): number {
  switch (signal) {
    case "SIGHUP":
      return 129;
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
  }
}

export function loadEnvironmentFile(path: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(path))) return;

    yield* Effect.try({
      try: () => process.loadEnvFile(path),
      catch: (cause) => new RunnerError({ message: `Failed to load environment file ${path}`, cause }),
    });
  });
}

export function stopChildProcess(handle: ChildProcessSpawner.ChildProcessHandle, label: string): Effect.Effect<void> {
  const forceKill = handle.kill({ killSignal: "SIGKILL" }).pipe(
    Effect.timeoutOrElse({
      duration: "500 millis",
      orElse: () => Effect.logWarning(`${label} did not exit after SIGKILL`),
    }),
  );

  const terminate = handle.kill({ killSignal: "SIGTERM" }).pipe(
    Effect.timeoutOrElse({
      duration: "1500 millis",
      orElse: () => forceKill,
    }),
    Effect.catchCause((cause) => Effect.logWarning(`Failed to stop ${label}`, cause)),
  );

  return handle.isRunning.pipe(
    Effect.catchCause(() => Effect.succeed(false)),
    Effect.flatMap((running) => (running ? terminate : Effect.void)),
  );
}
