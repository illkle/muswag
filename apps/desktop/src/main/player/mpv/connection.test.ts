import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { describe, expect } from "vitest";
import { MpvConnection, MpvConnectionLive, windowsGuard } from "./connection";

// A fake mpv: a node process that listens on the IPC socket and answers every request with split UTF-8 lines.
const fakeMpv = `const net = require('node:net'); const server = net.createServer(socket => { socket.on('data', () => { const bytes = Buffer.from('héllo\\r\\nsecond\\n'); socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2))); }); }); server.listen(process.argv[1]);`;
/** Another, which answers a request with more lines in one write than anybody reads in one go. */
const BURST = 2000;
const chattyMpv = `const net = require('node:net'); const server = net.createServer(socket => { socket.on('data', () => { socket.write(Array.from({ length: ${BURST} }, (_, index) => 'line ' + index + '\\n').join('')); }); }); server.listen(process.argv[1]);`;
const spawnFakeMpv = (path: string, script = fakeMpv) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make(() => native.spawn(ChildProcess.make(process.execPath, ["-e", script, path], { forceKillAfter: "100 millis" })));
    }),
  ).pipe(Layer.provide(NodeServices.layer));

describe("the guard that ends mpv on Windows", () => {
  it.effect("waits for the app's process, then ends that process only if it is an mpv", () =>
    Effect.sync(() => {
      const guard = windowsGuard(1234, 5678);
      expect(guard).toMatchObject({ command: "powershell.exe" });
      const script = (guard as unknown as { args: readonly string[] }).args.at(-1);
      expect(script).toBe(
        "try { Wait-Process -Id 1234 -ErrorAction Stop } catch {}; Get-Process -Id 5678 -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'mpv*' } | Stop-Process -Force",
      );
    }),
  );
});

describe.runIf(process.platform !== "win32")("local process/socket adapter", () => {
  it.live("frames split UTF-8 lines and removes the owned socket after reaping the child", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = join(yield* fs.makeTempDirectoryScoped({ prefix: "muswag-socket-" }), "ipc");
      yield* Effect.gen(function* () {
        const connection = yield* (yield* MpvConnection).open("fake-mpv", path);
        yield* connection.write("request\n");
        expect(yield* connection.lines.pipe(Stream.take(2), Stream.runCollect)).toEqual(["héllo", "second"]);
      }).pipe(Effect.scoped, Effect.provide(MpvConnectionLive().pipe(Layer.provide(spawnFakeMpv(path)), Layer.provide(NodeServices.layer))));
      expect(yield* fs.exists(path)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.live("keeps every line of a burst, such as what mpv said while the main thread stood still", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = join(yield* fs.makeTempDirectoryScoped({ prefix: "muswag-socket-" }), "ipc");
      yield* Effect.gen(function* () {
        const connection = yield* (yield* MpvConnection).open("fake-mpv", path);
        yield* connection.write("request\n");
        const lines = yield* connection.lines.pipe(Stream.take(BURST), Stream.runCollect);
        expect(lines.at(-1)).toBe(`line ${BURST - 1}`);
      }).pipe(Effect.scoped, Effect.provide(MpvConnectionLive().pipe(Layer.provide(spawnFakeMpv(path, chattyMpv)), Layer.provide(NodeServices.layer))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
