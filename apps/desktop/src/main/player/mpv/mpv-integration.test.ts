import type { EngineError } from "../errors";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { MpvConnectionLive } from "./connection";
import { MpvSession, MpvSessionLive } from "./session";
import { booleanProperty, command, numberProperty } from "./protocol";
import { applyQueue } from "../queue";

// Explicitly opt in; CI's mpv job should set this and provide mpv >= 0.41.
describe.runIf(process.env.MUSWAG_MPV_INTEGRATION === "1")("real mpv session", () => {
  it("loads exact duplicate-media occurrences, pauses/seeks, advances and closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "muswag-effect-mpv-"));
    try {
      const file = join(root, "audio.wav");
      await writeFile(file, createWave(440));
      const live = MpvSessionLive(join(root, "ipc")).pipe(Layer.provide(MpvConnectionLive(["--ao=null"])));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* MpvSession;
            const loaded = yield* Deferred.make<void, EngineError>();
            const ended = yield* Deferred.make<void, EngineError>();
            const starts: number[] = [];
            const session = yield* service.open(
              process.env.MUSWAG_MPV_PATH ?? "mpv",
              (message) => {
                if (message.event.type === "start-file") starts.push(message.event.entryId);
                if (message.event.type === "file-loaded") Deferred.doneUnsafe(loaded, Effect.void);
                if (message.event.type === "end-file" && starts.length === 3 && message.event.reason === "eof") Deferred.doneUnsafe(ended, Effect.void);
                return true;
              },
              (error) => {
                Deferred.doneUnsafe(loaded, Effect.fail(error));
                Deferred.doneUnsafe(ended, Effect.fail(error));
              },
            );
            yield* session.execute(command("set_property", "pause", true));
            const items = ["a", "b", "c"].map((key) => ({ key, track: { id: "same", title: key, isDir: false } }));
            const mirrored = yield* applyQueue(session, null, items, { key: "a", play: false, positionSeconds: 0 }, new Map(items.map((item) => [item.key, file])));
            expect(mirrored.entries.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
            yield* Deferred.await(loaded);
            expect(yield* session.execute(booleanProperty("pause"))).toBe(true);
            yield* session.execute(command("seek", 0.2, "absolute+exact"));
            expect(yield* session.execute(numberProperty("time-pos"))).toBeGreaterThanOrEqual(0);
            yield* session.execute(command("set_property", "pause", false));
            yield* Deferred.await(ended);
            expect(new Set(starts).size).toBe(3);
          }).pipe(Effect.provide(live)),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
});

function createWave(frequency: number): Buffer {
  const sampleRate = 44_100;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((index * frequency * Math.PI * 2) / sampleRate) * 8_000), 44 + index * 2);
  }
  return buffer;
}
