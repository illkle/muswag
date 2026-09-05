import { spawn } from "node:child_process";
import { Deferred, Effect } from "effect";

export type CommandResult = { code: number | null; errorCode: string | null; stdout: string; stderr: string };
export function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Effect.Effect<CommandResult> {
  return Effect.scoped(
    Effect.gen(function* () {
      const done = yield* Deferred.make<CommandResult>();
      const closed = yield* Deferred.make<void>();
      let stdout = "";
      let stderr = "";
      let errorCode: string | null = null;
      const child = yield* Effect.acquireRelease(Effect.try({ try: () => spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] }), catch: () => "UNKNOWN" }), (child) =>
        Effect.gen(function* () {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          yield* Deferred.await(closed).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.logWarning("Binary probe did not report closure") }));
          child.removeAllListeners();
          child.stdout.removeAllListeners();
          child.stderr.removeAllListeners();
        }),
      );
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-65536);
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-65536);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        errorCode = error.code ?? "UNKNOWN";
      });
      child.once("close", (code) => {
        Deferred.doneUnsafe(done, Effect.succeed({ code: errorCode ? null : code, errorCode, stdout, stderr }));
        Deferred.doneUnsafe(closed, Effect.void);
      });
      return yield* Deferred.await(done).pipe(Effect.timeoutOrElse({ duration: options.timeoutMs ?? 5000, orElse: () => Effect.succeed({ code: null, errorCode: "ETIMEDOUT", stdout, stderr }) }));
    }),
  ).pipe(Effect.catch(() => Effect.succeed({ code: null, errorCode: "UNKNOWN", stdout: "", stderr: "" })));
}
