import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { describe, expect } from "vitest";
import { MpvConnection, MpvConnectionLive } from "./connection";

// A fake mpv: a node process that listens on the IPC socket and answers every request with split UTF-8 lines.
const fakeMpv = `const net = require('node:net'); const server = net.createServer(socket => { socket.on('data', () => { const bytes = Buffer.from('héllo\\r\\nsecond\\n'); socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2))); }); }); server.listen(process.argv[1]);`;
const spawnFakeMpv = (path: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const native = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make(() => native.spawn(ChildProcess.make(process.execPath, ["-e", fakeMpv, path], { forceKillAfter: "100 millis" })));
    }),
  ).pipe(Layer.provide(NodeServices.layer));

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
});
