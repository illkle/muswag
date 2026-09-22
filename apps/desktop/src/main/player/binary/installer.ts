import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { delimiter, dirname } from "node:path";
import { Context, Deferred, Effect, FiberHandle, Layer, Semaphore, Stream, SubscriptionRef } from "effect";
import type { InstallOutput, InstallState, MpvInstallMethod } from "#shared/player-contract";
import { Busy, InstallFailed, toIssue } from "../errors";
import { installationLines } from "../support/output";
import { Binaries } from "./binaries";

const OUTPUT_TAIL = 100;

export type InstallProgress = { readonly state: InstallState; readonly output: readonly InstallOutput[] };
export class Installer extends Context.Service<
  Installer,
  {
    /** Starts an automatic install and resolves with its job id once the package manager is running. */
    readonly start: (method: MpvInstallMethod) => Effect.Effect<string, Busy | InstallFailed>;
    readonly cancel: (jobId: string) => Effect.Effect<void>;
    readonly changes: Stream.Stream<InstallProgress>;
  }
>()("@muswag/player/Installer") {}

const failure = (message: string) => new InstallFailed({ operation: "install", message });
const isActive = (state: InstallState): state is Extract<InstallState, { _tag: "Running" | "Cancelling" }> => state._tag === "Running" || state._tag === "Cancelling";

export const InstallerLive = Layer.effect(
  Installer,
  Effect.gen(function* () {
    const binaries = yield* Binaries;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const progress = yield* SubscriptionRef.make<InstallProgress>({ state: { _tag: "Idle" }, output: [] });
    /** The single running job, if any. Closing the layer scope interrupts it. */
    const job = yield* FiberHandle.make<void>();
    const lock = yield* Semaphore.make(1);

    const setState = (state: InstallState) => SubscriptionRef.update(progress, (current) => ({ ...current, state }));

    /** Runs the package manager to completion, streaming its output tail into `progress`. */
    const runPackageManager = Effect.fn("Installer.runPackageManager")(function* (jobId: string, managerPath: string, args: readonly string[], spawned: Deferred.Deferred<void>) {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(managerPath, args, {
            env: {
              PATH: [dirname(managerPath), process.env.PATH, "/usr/bin", "/bin"].join(delimiter),
              NONINTERACTIVE: "1",
              HOMEBREW_NO_AUTO_UPDATE: "1",
              HOMEBREW_NO_ANALYTICS: "1",
            },
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: "1 second",
          }),
        )
        .pipe(Effect.mapError(() => failure("Unable to start the package manager.")));
      yield* Deferred.succeed(spawned, undefined);
      let sequence = 0;
      const capture = (stream: "stdout" | "stderr") =>
        installationLines(child[stream]).pipe(
          Stream.runForEach((line) => SubscriptionRef.update(progress, (current) => ({ ...current, output: [...current.output, { jobId, sequence: ++sequence, stream, line }].slice(-OUTPUT_TAIL) }))),
        );
      const [code] = yield* Effect.all([child.exitCode, capture("stdout"), capture("stderr")], { concurrency: "unbounded" }).pipe(
        Effect.mapError(() => failure("Package manager or output stream failed.")),
      );
      if (code !== 0) return yield* failure("Package manager exited unsuccessfully. See installation output.");
    }, Effect.scoped);

    const start = Effect.fn("Installer.start")(function* (method: MpvInstallMethod) {
      if (isActive((yield* SubscriptionRef.get(progress)).state)) return yield* new Busy({ operation: "install", message: "Another installation is running." });
      const candidate = yield* binaries.candidate(method);
      if (!candidate?.managerPath || !candidate.option.automatic) return yield* failure("Run the suggested installation command in a terminal.");
      const id = crypto.randomUUID();
      const spawned = yield* Deferred.make<void>();
      yield* SubscriptionRef.set(progress, { state: { _tag: "Running", jobId: id, method }, output: [] });
      yield* runPackageManager(id, candidate.managerPath, candidate.args, spawned).pipe(
        Effect.matchEffect({
          onSuccess: () => setState({ _tag: "Succeeded", jobId: id, method }),
          onFailure: (error) => setState({ _tag: "Failed", jobId: id, method, issue: toIssue(error) }),
        }),
        Effect.onInterrupt(() => setState({ _tag: "Cancelled", jobId: id, method })),
        Effect.ensuring(Deferred.succeed(spawned, undefined)),
        FiberHandle.run(job),
      );
      // Return once the process exists, so an immediate cancel always has something to terminate.
      yield* Deferred.await(spawned);
      return id;
    }, lock.withPermit);

    const cancel = Effect.fn("Installer.cancel")(function* (jobId: string) {
      const { state } = yield* SubscriptionRef.get(progress);
      if (state._tag !== "Running" || state.jobId !== jobId) return;
      yield* setState({ _tag: "Cancelling", jobId, method: state.method });
      yield* FiberHandle.clear(job);
      yield* setState({ _tag: "Cancelled", jobId, method: state.method });
    }, lock.withPermit);

    return { start, cancel, changes: SubscriptionRef.changes(progress) };
  }),
);
