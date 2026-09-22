import { Effect, Ref, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type CommandResult = { code: number | null; errorCode: string | null; stdout: string; stderr: string };
/** Runs a short-lived command to completion, keeping a bounded tail of its output. Never fails: problems become `errorCode`. */
export const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Effect.fn.Return<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdout = yield* Ref.make("");
  const stderr = yield* Ref.make("");
  const result = (code: number | null, errorCode: string | null) =>
    Effect.gen(function* () {
      return { code, errorCode, stdout: yield* Ref.get(stdout), stderr: yield* Ref.get(stderr) };
    });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(ChildProcess.make(command, args, { env: options.env, stdin: "ignore", forceKillAfter: "1 second" }));
      const capture = (stream: typeof child.stdout, target: Ref.Ref<string>) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(target, (tail) => (tail + chunk).slice(-65536))),
        );
      const [code] = yield* Effect.all([child.exitCode, capture(child.stdout, stdout), capture(child.stderr, stderr)], { concurrency: "unbounded" });
      return yield* result(code, null);
    }).pipe(
      Effect.timeoutOrElse({ duration: options.timeoutMs ?? 5000, orElse: () => result(null, "ETIMEDOUT") }),
      Effect.catch((error) => result(null, error.reason._tag === "NotFound" ? "ENOENT" : error.reason._tag === "PermissionDenied" ? "EACCES" : "UNKNOWN")),
    ),
  );
});
