import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { rm } from "node:fs/promises";
import { Cause, Context, Deferred, Effect, Layer, Queue, Schedule, Scope, Stream } from "effect";
import { EngineError } from "../errors";

export interface Connection {
  readonly lines: Stream.Stream<string, EngineError>;
  readonly write: (line: string) => Effect.Effect<void, EngineError>;
}
export class MpvConnection extends Context.Service<
  MpvConnection,
  {
    readonly open: (binaryPath: string, ipcPath: string) => Effect.Effect<Connection, EngineError, Scope.Scope>;
  }
>()("@muswag/player/MpvConnection") {}
const failure = (reason: EngineError["reason"]) => new EngineError({ reason, operation: "connection", uncertain: true });

export const MpvConnectionLive = (extraArgs: readonly string[] = [], spawnProcess: typeof spawn = spawn) =>
  Layer.succeed(MpvConnection, {
    open: (binaryPath, ipcPath) =>
      Effect.gen(function* () {
        const lines = yield* Queue.bounded<string, EngineError>(256);
        const closed = yield* Deferred.make<void>();
        const startupFailure = yield* Deferred.make<never, EngineError>();
        let closing = false;
        const fail = (reason: EngineError["reason"]) => Queue.failCauseUnsafe(lines, Cause.fail(failure(reason)));
        const child = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              spawnProcess(
                binaryPath,
                [
                  "--no-config",
                  "--idle=yes",
                  "--no-video",
                  "--audio-display=no",
                  "--force-window=no",
                  "--terminal=no",
                  "--gapless-audio=weak",
                  "--prefetch-playlist=yes",
                  ...extraArgs,
                  `--input-ipc-server=${ipcPath}`,
                ],
                { stdio: ["ignore", "ignore", "pipe"] },
              ),
            catch: () => failure("spawn"),
          }),
          (process) =>
            Effect.gen(function* () {
              closing = true;
              yield* Deferred.await(closed).pipe(
                Effect.timeoutOrElse({
                  duration: "250 millis",
                  orElse: () =>
                    Effect.sync(() => {
                      if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
                    }),
                }),
              );
              yield* Deferred.await(closed).pipe(
                Effect.timeoutOrElse({
                  duration: "1 second",
                  orElse: () =>
                    Effect.sync(() => {
                      process.kill("SIGKILL");
                    }),
                }),
              );
              yield* Deferred.await(closed).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.logWarning("mpv did not report process closure") }));
              process.removeAllListeners();
              process.stderr?.removeAllListeners();
              if (globalThis.process.platform !== "win32") yield* Effect.tryPromise(() => rm(ipcPath, { force: true })).pipe(Effect.ignore);
            }),
        );
        child.stderr?.resume(); // Drain, but never log credential-bearing engine output.
        child.on("error", () => {
          fail("spawn");
          Deferred.doneUnsafe(startupFailure, Effect.fail(failure("spawn")));
          Deferred.doneUnsafe(closed, Effect.void);
        });
        child.on("close", () => {
          Deferred.doneUnsafe(closed, Effect.void);
          if (!closing) {
            fail("closed");
            Deferred.doneUnsafe(startupFailure, Effect.fail(failure("closed")));
          }
        });
        const connect = Effect.callback<Socket, EngineError>((resume) => {
          const socket = createConnection(ipcPath);
          const error = () => {
            socket.destroy();
            resume(Effect.fail(failure("connect")));
          };
          socket.once("error", error);
          socket.once("connect", () => {
            socket.off("error", error);
            resume(Effect.succeed(socket));
          });
          return Effect.sync(() => {
            socket.removeAllListeners("connect");
            socket.off("error", error);
            if (socket.connecting) socket.destroy();
          });
        });
        const socket = yield* Effect.acquireRelease(
          connect.pipe(
            Effect.retry(Schedule.spaced("100 millis")),
            Effect.raceFirst(Deferred.await(startupFailure)),
            Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(failure("connect")) }),
          ),
          (socket) =>
            Effect.gen(function* () {
              closing = true;
              if (!socket.destroyed)
                yield* Effect.callback<void>((resume) => {
                  socket.end(`${JSON.stringify({ command: ["quit"] })}\n`, () => resume(Effect.void));
                }).pipe(Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.void }));
              socket.destroy();
              socket.removeAllListeners();
            }),
        );
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 1024 * 1024) {
            fail("protocol");
            socket.destroy();
            return;
          }
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end).replace(/\r$/, "");
            buffer = buffer.slice(end + 1);
            if (!Queue.offerUnsafe(lines, line)) {
              fail("protocol");
              socket.destroy();
              return;
            }
          }
        });
        socket.on("error", () => {
          if (!closing) fail("closed");
        });
        socket.on("close", () => {
          if (!closing) fail(buffer.trim() ? "protocol" : "closed");
        });
        yield* Effect.addFinalizer(() => Queue.shutdown(lines));
        return {
          lines: Stream.fromQueue(lines),
          write: (line: string) =>
            Effect.callback<void, EngineError>((resume) => {
              if (socket.destroyed) {
                resume(Effect.fail(failure("closed")));
                return;
              }
              socket.write(line, (error) => resume(error ? Effect.fail(failure("closed")) : Effect.void));
            }),
        };
      }),
  });
