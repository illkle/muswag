import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import { Cause, Context, Deferred, Effect, Fiber, Layer, Queue, Semaphore, Stream, SubscriptionRef } from "effect";
import type { InstallOutput, InstallState } from "#shared/player-contract";
import type { MpvInstallMethod } from "#shared/player";
import { playerError, type PlayerError } from "../errors";
import { terminateInstaller } from "../support/terminate";
import { Binaries } from "./binaries";
import { getManagerBinDirectory } from "./install-catalog";

export class Installer extends Context.Service<
  Installer,
  {
    readonly start: (method: MpvInstallMethod) => Effect.Effect<string, PlayerError>;
    readonly cancel: (jobId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<{ state: InstallState; output: readonly InstallOutput[] }>;
  }
>()("@muswag/player/Installer") {}
export const makeInstallerLayer = (spawnProcess: typeof spawn = spawn) =>
  Layer.effect(
    Installer,
    Effect.gen(function* () {
      const binaries = yield* Binaries;
      const scope = yield* Effect.scope;
      const state = yield* SubscriptionRef.make<{ state: InstallState; output: readonly InstallOutput[] }>({ state: { _tag: "Idle" }, output: [] });
      const lock = yield* Semaphore.make(1);
      let running: { id: string; fiber: Fiber.Fiber<void> | null; method: MpvInstallMethod } | null = null;
      const start = (method: MpvInstallMethod) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (running) return yield* Effect.fail(playerError("Busy", "install", "Another installation is running."));
            const candidate = yield* binaries.candidate(method);
            if (!candidate?.managerPath || !candidate.option.automatic) return yield* Effect.fail(playerError("InstallFailed", "install", "Run the suggested installation command in a terminal."));
            const id = crypto.randomUUID();
            const output = yield* Queue.sliding<InstallOutput, Cause.Done>(100);
            const started = yield* Deferred.make<void>();
            yield* SubscriptionRef.set(state, { state: { _tag: "Running", jobId: id, method }, output: [] });
            const job = Effect.scoped(
              Effect.gen(function* () {
                const done = yield* Deferred.make<number | null, PlayerError>();
                const closed = yield* Deferred.make<void>();
                let sequence = 0;
                const child = yield* Effect.acquireRelease(
                  Effect.try({
                    try: () =>
                      spawnProcess(candidate.managerPath!, candidate.args, {
                        env: {
                          ...process.env,
                          PATH: [getManagerBinDirectory(candidate.managerPath!), process.env.PATH, "/usr/bin", "/bin"].join(delimiter),
                          NONINTERACTIVE: "1",
                          HOMEBREW_NO_AUTO_UPDATE: "1",
                          HOMEBREW_NO_ANALYTICS: "1",
                        },
                        stdio: ["ignore", "pipe", "pipe"],
                        detached: process.platform !== "win32",
                      }),
                    catch: () => playerError("InstallFailed", "install", "Unable to start the package manager."),
                  }),
                  (child) =>
                    Effect.gen(function* () {
                      if (child.exitCode === null && child.signalCode === null) yield* terminateInstaller(child, "SIGTERM");
                      yield* Deferred.await(closed).pipe(
                        Effect.timeoutOrElse({
                          duration: "1 second",
                          orElse: () => terminateInstaller(child, "SIGKILL"),
                        }),
                      );
                      yield* Deferred.await(closed).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.logWarning("Installer did not report closure") }));
                      child.removeAllListeners();
                      child.stdout?.removeAllListeners();
                      child.stderr?.removeAllListeners();
                    }),
                );
                for (const source of ["stdout", "stderr"] as const) {
                  let buffer = "";
                  child[source]?.on("end", () => {
                    if (buffer) Queue.offerUnsafe(output, { jobId: id, sequence: ++sequence, stream: source, line: buffer.replace(/https?:\/\/\S+/g, "[url]").slice(0, 2048) });
                    buffer = "";
                  });
                  child[source]?.setEncoding("utf8").on("data", (chunk: string) => {
                    buffer = (buffer + chunk).slice(-8192);
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() ?? "";
                    for (const line of lines) Queue.offerUnsafe(output, { jobId: id, sequence: ++sequence, stream: source, line: line.replace(/https?:\/\/\S+/g, "[url]").slice(0, 2048) });
                  });
                }
                child.on("error", () => {
                  Deferred.doneUnsafe(done, Effect.fail(playerError("InstallFailed", "install", "Package manager failed to start.")));
                  Deferred.doneUnsafe(closed, Effect.void);
                });
                child.on("close", (code) => {
                  Queue.endUnsafe(output);
                  Deferred.doneUnsafe(done, Effect.succeed(code));
                  Deferred.doneUnsafe(closed, Effect.void);
                });
                const outputFiber = yield* Stream.runForEach(Stream.fromQueue(output), (line) =>
                  SubscriptionRef.update(state, (current) => ({ ...current, output: [...current.output, line].slice(-100) })),
                ).pipe(Effect.forkScoped);
                yield* Deferred.succeed(started, undefined);
                const code = yield* Deferred.await(done);
                yield* Fiber.join(outputFiber);
                if (code !== 0) return yield* Effect.fail(playerError("InstallFailed", "install", "Package manager exited unsuccessfully. See installation output."));
              }),
            ).pipe(
              Effect.matchEffect({
                onSuccess: () => SubscriptionRef.update(state, (current) => ({ ...current, state: { _tag: "Succeeded" as const, jobId: id, method } })),
                onFailure: (error) => SubscriptionRef.update(state, (current) => ({ ...current, state: { _tag: "Failed" as const, jobId: id, method, issue: error.issue } })),
              }),
              Effect.onInterrupt(() => SubscriptionRef.update(state, (current) => ({ ...current, state: { _tag: "Cancelled" as const, jobId: id, method } }))),
              Effect.ensuring(Deferred.succeed(started, undefined)),
              Effect.ensuring(
                Effect.sync(() => {
                  if (running?.id === id) running = null;
                }),
              ),
            );
            running = { id, fiber: null, method };
            const fiber = yield* Effect.forkIn(job, scope);
            if (running?.id === id) running.fiber = fiber;
            yield* Deferred.await(started);
            return id;
          }),
        );
      const cancel = (jobId: string) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (running?.id !== jobId) return;
            const active = running;
            yield* SubscriptionRef.update(state, (current) => ({ ...current, state: { _tag: "Cancelling" as const, jobId, method: active.method } }));
            if (active.fiber) yield* Fiber.interrupt(active.fiber);
            running = null;
            yield* SubscriptionRef.update(state, (current) => ({ ...current, state: { _tag: "Cancelled" as const, jobId, method: active.method } }));
          }),
        );
      return { start, cancel, changes: SubscriptionRef.changes(state) };
    }),
  );

export const InstallerLive = makeInstallerLayer();
