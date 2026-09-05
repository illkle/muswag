import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe, expect } from "vitest";
import { Binaries } from "./binaries";
import { Installer, makeInstallerLayer } from "./installer";

function fakeChild() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: (signal: string) => {
      child.signalCode = signal;
      events.emit("close", null, signal);
      return true;
    },
  });
  return child;
}
describe("installer job lifetime", () => {
  it.effect("rejects concurrent installs, cancels normally and isolates the next job", () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawnProcess = (() => {
      const child = fakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as typeof spawn;
    const layer = makeInstallerLayer(spawnProcess).pipe(
      Layer.provide(
        Layer.succeed(Binaries, {
          resolve: () => Effect.die("unused"),
          candidate: () => Effect.succeed({ managerPath: "/brew", args: ["install", "mpv"], option: { method: "brew", automatic: true, command: "brew install mpv", note: null, url: null } }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const installer = yield* Installer;
      const id = yield* installer.start("brew");
      expect((yield* installer.start("brew").pipe(Effect.result))._tag).toBe("Failure");
      yield* installer.cancel(id);
      const cancelled = yield* installer.changes.pipe(Stream.take(1), Stream.runCollect);
      expect(cancelled[0]?.state).toMatchObject({ _tag: "Cancelled", jobId: id });
      const next = yield* installer.start("brew");
      expect(next).not.toBe(id);
      children[0]!.emit("close", 0, null);
      const current = yield* installer.changes.pipe(Stream.take(1), Stream.runCollect);
      expect(current[0]?.state).toMatchObject({ _tag: "Running", jobId: next });
      yield* installer.cancel(next);
      expect(children.every((child) => child.signalCode === "SIGTERM")).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
