import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { Cause, Context, Deferred, Effect, Layer, Queue, Schedule, Scope, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EngineError } from "../errors";

export interface Connection {
  readonly lines: Stream.Stream<string, EngineError>;
  readonly write: (line: string) => Effect.Effect<void, EngineError>;
}
export class MpvConnection extends Context.Service<MpvConnection, { readonly open: (binaryPath: string, ipcPath: string) => Effect.Effect<Connection, EngineError, Scope.Scope> }>()(
  "@muswag/player/MpvConnection",
) {}
const failure = (reason: EngineError["reason"]) => new EngineError({ reason, operation: "connection", uncertain: true });
/**
 * Headless, config-free audio playback controlled only through the IPC socket.
 *
 * `fastseek`: without it, ffmpeg seeks in an mp3 that has no seek table by reading every byte up to the
 * target, which over a slow stream means minutes of silent downloading before a seek deep into a long
 * mix lands. With it, ffmpeg jumps to the position the bitrate implies: exact for constant-bitrate files,
 * a few seconds off at worst for variable-bitrate ones.
 *
 * `ytdl=no`: otherwise mpv hands every URL that fails to open to yt-dlp, when that is installed. That puts
 * the signed stream URL on another process's command line and delays the failure by seconds.
 */
const MPV_ARGS = [
  "--no-config",
  "--idle=yes",
  "--no-video",
  "--audio-display=no",
  "--force-window=no",
  "--terminal=no",
  "--gapless-audio=weak",
  "--prefetch-playlist=yes",
  "--ytdl=no",
  "--demuxer-lavf-o-add=fflags=+fastseek",
];
/**
 * On POSIX mpv is also given one end of a socket pair, as an IPC client it never hears from. mpv quits
 * when that connection closes, which the system does when the app's process ends, however it ends:
 * without it, an mpv whose app crashed would play on with nothing to stop it. mpv has no such option on
 * Windows, where a guard stands in for it (`windowsGuard`).
 */
const LIFELINE_FD = 3;
const hasLifeline = process.platform !== "win32";

/**
 * What stands in for the lifeline on Windows, which neither ends a process's children with it nor
 * lets mpv notice that its app is gone: a PowerShell process that waits for the app's process to end,
 * however it ends, and then ends mpv. It is started with every session and stopped with it, so it
 * only ever acts when the app did not get to close mpv itself. It ends a process only if that is
 * still an mpv, since by then the id may be another program's.
 */
export const windowsGuard = (appPid: number, mpvPid: number) =>
  ChildProcess.make(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `try { Wait-Process -Id ${appPid} -ErrorAction Stop } catch {}; Get-Process -Id ${mpvPid} -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'mpv*' } | Stop-Process -Force`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: "1 second" },
  );
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How often to look for the socket mpv creates once it has started. */
const CONNECT_INTERVAL = "10 millis";

export const MpvConnectionLive = (extraArgs: readonly string[] = []) =>
  Layer.effect(
    MpvConnection,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem;
      return {
        open: (binaryPath, ipcPath) =>
          Effect.gen(function* () {
            // Unbounded: after the main thread stalls, everything mpv said meanwhile arrives at once.
            const lines = yield* Queue.unbounded<string, EngineError>();
            yield* Effect.addFinalizer(() => Queue.shutdown(lines));
            if (process.platform !== "win32") yield* Effect.addFinalizer(() => fs.remove(ipcPath, { force: true }).pipe(Effect.ignore));
            const child = yield* spawner
              .spawn(
                ChildProcess.make(binaryPath, [...MPV_ARGS, ...extraArgs, `--input-ipc-server=${ipcPath}`, ...(hasLifeline ? [`--input-ipc-client=fd://${LIFELINE_FD}`] : [])], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                  forceKillAfter: "1 second",
                  ...(hasLifeline ? { additionalFds: { [`fd${LIFELINE_FD}`]: { type: "output" } } } : {}),
                }),
              )
              .pipe(Effect.mapError(() => failure("spawn")));
            // mpv reports its events to the lifeline as to any client; read away, they cannot fill it up.
            if (hasLifeline) yield* child.getOutputFd(LIFELINE_FD).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
            // Playback does not depend on the guard: without PowerShell there is only none.
            else yield* spawner.spawn(windowsGuard(process.pid, child.pid)).pipe(Effect.ignore);
            const opened = yield* Deferred.make<void, EngineError>();
            const failed = yield* Deferred.make<never, EngineError>();
            const fail = (error: EngineError) =>
              Effect.gen(function* () {
                yield* Deferred.fail(opened, error);
                yield* Deferred.fail(failed, error);
                yield* Queue.failCause(lines, Cause.fail(error));
              });
            yield* child.exitCode.pipe(Effect.matchEffect({ onSuccess: () => fail(failure("closed")), onFailure: () => fail(failure("closed")) }), Effect.forkScoped);
            const socket = yield* NodeSocket.makeNet({ path: ipcPath, openTimeout: "1 second" });
            let connected = false;
            let buffer = "";
            const decoder = new TextDecoder();
            // Process each batch in wire order; NodeSocket owns backpressure and disposal.
            const read = Effect.gen(function* () {
              const reader = yield* socket.reader;
              connected = true;
              yield* Deferred.succeed(opened, undefined);
              while (true) {
                const chunks = yield* reader.pull;
                for (const chunk of chunks) {
                  buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
                  if (Buffer.byteLength(buffer) > MAX_BUFFERED_BYTES) return yield* Effect.fail(failure("protocol"));
                  let end: number;
                  while ((end = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, end).replace(/\r$/, "");
                    buffer = buffer.slice(end + 1);
                    Queue.offerUnsafe(lines, line);
                  }
                }
              }
            }).pipe(
              Effect.scoped,
              Effect.retry({ schedule: Schedule.spaced(CONNECT_INTERVAL), while: (error) => !connected && error._tag === "SocketError" && error.reason._tag === "SocketOpenError" }),
              Effect.mapError((error) => (error instanceof EngineError ? error : failure(connected ? (buffer.trim() ? "protocol" : "closed") : "connect"))),
              Effect.catch(fail),
            );
            yield* read.pipe(Effect.forkScoped);
            yield* Deferred.await(opened).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(failure("connect")) }));
            const writer = yield* socket.writer;
            const write = (line: string) =>
              writer.write(line).pipe(
                Effect.mapError(() => failure("closed")),
                Effect.raceFirst(Deferred.await(failed)),
              );
            yield* Effect.addFinalizer(() => write('{"command":["quit"]}\n').pipe(Effect.timeoutOrElse({ duration: "100 millis", orElse: () => Effect.void }), Effect.ignore));
            return { lines: Stream.fromQueue(lines), write };
          }),
      };
    }),
  );
