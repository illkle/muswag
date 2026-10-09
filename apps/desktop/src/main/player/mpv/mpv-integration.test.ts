import * as NodeServices from "@effect/platform-node/NodeServices";
import { songRow } from "@muswag/model";
import type { EngineError } from "../errors";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, Queue, Redacted, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { MpvConnectionLive } from "./connection";
import { MpvSession, MpvSessionLive, type SessionEvent } from "./session";
import { booleanProperty, command, numberProperty } from "./protocol";
import { applyQueue } from "../queue";

// Explicitly opt in; CI's mpv job should set this and provide an mpv of at least `MINIMUM_MPV_VERSION`.
describe.runIf(process.env.MUSWAG_MPV_INTEGRATION === "1")("real mpv session", () => {
  it("loads exact duplicate-media occurrences, pauses/seeks, selects in place, edits, advances and closes", async () => {
    const root = await mkdtemp(join(tmpdir(), "muswag-effect-mpv-"));
    try {
      const file = join(root, "audio.wav");
      await writeFile(file, createWave(440));
      const live = MpvSessionLive(join(root, "ipc")).pipe(Layer.provide(MpvConnectionLive(["--ao=null"])), Layer.provide(NodeServices.layer));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* MpvSession;
            const loaded = yield* Deferred.make<void, EngineError>();
            const ended = yield* Deferred.make<void, EngineError>();
            const starts: number[] = [];
            const events = yield* Queue.unbounded<SessionEvent>();
            const positions = yield* Queue.sliding<SessionEvent>(1);
            const session = yield* service.open(process.env.MUSWAG_MPV_PATH ?? "mpv", { events, positions });
            yield* Stream.fromQueue(events).pipe(
              Stream.runForEach(({ event }) =>
                Effect.gen(function* () {
                  if (event.type === "start-file") starts.push(event.entryId);
                  if (event.type === "file-loaded") yield* Deferred.succeed(loaded, undefined);
                  if (event.type === "end-file" && starts.length === 3 && event.reason === "eof") yield* Deferred.succeed(ended, undefined);
                }),
              ),
              Effect.forkScoped,
            );
            yield* session.failure.pipe(
              Effect.catch((error) => Effect.all([Deferred.fail(loaded, error), Deferred.fail(ended, error)])),
              Effect.forkScoped,
            );
            yield* session.execute(command("set_property", "pause", true));
            const [a, b, c, d] = ["a", "b", "c", "d"].map((key) => ({ key, track: songRow({ id: "same", title: key }) }));
            const items = [a!, b!, c!];
            const urls = new Map([...items, d!].map((item) => [item.key, Redacted.make(file)]));
            const mirrored = yield* applyQueue(session, null, items, { key: "a", play: false, positionSeconds: 0 }, urls);
            expect(mirrored.entries.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
            yield* Deferred.await(loaded);
            expect(yield* session.execute(booleanProperty("pause"))).toBe(true);
            yield* session.execute(command("seek", 0.2, "absolute+exact"));
            expect(yield* session.execute(numberProperty("time-pos"))).toBeGreaterThanOrEqual(0);
            // mpv starts an occurrence it already holds without a new playlist, and an edit only sends its difference.
            const selected = yield* applyQueue(session, mirrored, items, { key: "c", play: false, positionSeconds: 0 }, urls);
            expect(selected.entries).toEqual(mirrored.entries);
            expect(selected.currentId).toBe(mirrored.entries[2]!.entryId);
            const edited = yield* applyQueue(session, selected, [b!, c!, d!], null, urls);
            expect(edited.entries.slice(0, 2)).toEqual(mirrored.entries.slice(1));
            expect(edited.entries.map((entry) => entry.key)).toEqual(["b", "c", "d"]);
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
