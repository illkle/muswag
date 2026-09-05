import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { delimiter } from "node:path";
import { Context, Deferred, Effect, Fiber, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import type { InstallOutput, InstallState } from "#shared/player-contract";
import type { MpvInstallMethod } from "#shared/player";
import { playerError, type PlayerError } from "../errors";
import { Binaries } from "./binaries";
import { installationLines } from "../support/output";
import { getManagerBinDirectory } from "./install-catalog";

export class Installer extends Context.Service<
  Installer,
  {
    readonly start: (method: MpvInstallMethod) => Effect.Effect<string, PlayerError>;
    readonly cancel: (jobId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<{ state: InstallState; output: readonly InstallOutput[] }>;
  }
>()("@muswag/player/Installer") {}
export const InstallerLive = Layer.effect(
  Installer,
  Effect.gen(function* () {
    const binaries = yield* Binaries;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const state = yield* SubscriptionRef.make<{ state: InstallState; output: readonly InstallOutput[] }>({ state: { _tag: "Idle" }, output: [] });
    const lock = yield* Semaphore.make(1);
    let running: { id: string; fiber: Fiber.Fiber<void> | null; method: MpvInstallMethod } | null = null;
    const start = (method: MpvInstallMethod) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (running) return yield* playerError("Busy", "install", "Another installation is running.");
          const candidate = yield* binaries.candidate(method);
          if (!candidate?.managerPath || !candidate.option.automatic) return yield* playerError("InstallFailed", "install", "Run the suggested installation command in a terminal.");
          const id = crypto.randomUUID();
          const started = yield* Deferred.make<void>();
          yield* SubscriptionRef.set(state, { state: { _tag: "Running", jobId: id, method }, output: [] });
          const job = Effect.scoped(
            Effect.gen(function* () {
              let sequence = 0;
              const child = yield* spawner
                .spawn(
                  ChildProcess.make(candidate.managerPath!, candidate.args, {
                    env: {
                      PATH: [getManagerBinDirectory(candidate.managerPath!), process.env.PATH, "/usr/bin", "/bin"].join(delimiter),
                      NONINTERACTIVE: "1",
                      HOMEBREW_NO_AUTO_UPDATE: "1",
                      HOMEBREW_NO_ANALYTICS: "1",
                    },
                    extendEnv: true,
                    stdin: "ignore",
                    forceKillAfter: "1 second",
                  }),
                )
                .pipe(Effect.mapError(() => playerError("InstallFailed", "install", "Unable to start the package manager.")));
              const capture = (source: "stdout" | "stderr") =>
                installationLines(child[source]).pipe(
                  Stream.runForEach((line) =>
                    SubscriptionRef.update(state, (current) => ({
                      ...current,
                      output: [...current.output, { jobId: id, sequence: ++sequence, stream: source, line }].slice(-100),
                    })),
                  ),
                );
              yield* Deferred.succeed(started, undefined);
              const [code] = yield* Effect.all([child.exitCode, capture("stdout"), capture("stderr")], { concurrency: "unbounded" }).pipe(
                Effect.mapError(() => playerError("InstallFailed", "install", "Package manager or output stream failed.")),
              );
              if (code !== 0) return yield* playerError("InstallFailed", "install", "Package manager exited unsuccessfully. See installation output.");
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
