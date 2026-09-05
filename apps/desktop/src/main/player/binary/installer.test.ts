import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";
import { Binaries } from "./binaries";
import { Installer, InstallerLive } from "./installer";

const binaries = Layer.succeed(Binaries, {
  resolve: () => Effect.die("unused"),
  candidate: () => Effect.succeed({ managerPath: "/brew", args: ["install", "mpv"], option: { method: "brew", automatic: true, command: "brew install mpv", note: null, url: null } }),
});
describe("installer job lifetime", () => {
  it.effect("rejects concurrent installs, releases cancelled processes and isolates the next job", () =>
    Effect.gen(function* () {
      const children: { done: Deferred.Deferred<ChildProcessSpawner.ExitCode>; released: boolean }[] = [];
      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const done = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const child = { done, released: false };
            children.push(child);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                child.released = true;
              }),
            );
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(children.length),
              exitCode: Deferred.await(done),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const installer = yield* Installer;
        const id = yield* installer.start("brew");
        expect((yield* installer.start("brew").pipe(Effect.result))._tag).toBe("Failure");
        yield* installer.cancel(id);
        expect(children[0]?.released).toBe(true);
        expect((yield* installer.changes.pipe(Stream.take(1), Stream.runCollect))[0]?.state).toMatchObject({ _tag: "Cancelled", jobId: id });
        const next = yield* installer.start("brew");
        expect(next).not.toBe(id);
        yield* Deferred.succeed(children[0]!.done, ChildProcessSpawner.ExitCode(0));
        expect((yield* installer.changes.pipe(Stream.take(1), Stream.runCollect))[0]?.state).toMatchObject({ _tag: "Running", jobId: next });
        yield* installer.cancel(next);
        expect(children.every((child) => child.released)).toBe(true);
      }).pipe(Effect.provide(InstallerLive.pipe(Layer.provide([binaries, spawner]))));
    }),
  );
});
