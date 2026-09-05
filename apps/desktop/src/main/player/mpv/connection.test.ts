import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { MpvConnection, MpvConnectionLive } from "./connection";

describe.runIf(process.platform !== "win32")("local process/socket adapter", () => {
  it("frames split UTF-8 lines and removes the owned socket after reaping the child", async () => {
    const root = await mkdtemp(join(tmpdir(), "muswag-socket-"));
    const path = join(root, "ipc");
    const source = `const net = require('node:net'); const server = net.createServer(socket => { socket.on('data', () => { const bytes = Buffer.from('héllo\\r\\nsecond\\n'); socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2))); }); }); server.listen(process.argv[1]);`;
    const spawner = Layer.effect(
      ChildProcessSpawner.ChildProcessSpawner,
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        return ChildProcessSpawner.make(() => native.spawn(ChildProcess.make(process.execPath, ["-e", source, path], { forceKillAfter: "100 millis" })));
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* MpvConnection;
            const connection = yield* service.open("fake-mpv", path);
            yield* connection.write("request\n");
            const lines = yield* connection.lines.pipe(Stream.take(2), Stream.runCollect);
            expect(lines).toEqual(["héllo", "second"]);
          }).pipe(Effect.provide(MpvConnectionLive().pipe(Layer.provide(spawner), Layer.provide(NodeServices.layer)))),
        ),
      );
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
