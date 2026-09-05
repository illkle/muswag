import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { describe, expect } from "vitest";
import { EngineError } from "../errors";
import { MpvConnection } from "./connection";
import { command, load, parseMessage } from "./protocol";
import { MpvSession, MpvSessionLive } from "./session";

describe("mpv protocol", () => {
  it.effect("distinguishes malformed responses from unknown events and decodes entry ids", () =>
    Effect.gen(function* () {
      expect(yield* parseMessage('{"event":"uninteresting"}')).toEqual({ kind: "ignored" });
      expect((yield* parseMessage('{"request_id":1}').pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* load("secret", "replace").decode({ playlist_entry_id: "1" }).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* load("secret", "replace").decode({ playlist_entry_id: 1 })).toEqual({ playlist_entry_id: 1 });
    }),
  );
  it.effect("correlates reversed replies, expires requests, ignores late replies and cleans up", () =>
    Effect.gen(function* () {
      const lines = yield* Queue.unbounded<string, EngineError>();
      const writes = yield* Queue.unbounded<{ request_id: number; command: unknown[] }>();
      let closed = 0;
      const connection = Layer.succeed(MpvConnection, {
        open: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed++;
              }),
            );
            return {
              lines: Stream.fromQueue(lines),
              write: (line: string) =>
                Effect.gen(function* () {
                  const value = JSON.parse(line) as { request_id: number; command: unknown[] };
                  if (value.command[0] === "observe_property") yield* Queue.offer(lines, JSON.stringify({ request_id: value.request_id, error: "success" }));
                  else yield* Queue.offer(writes, value);
                }),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MpvSession;
          const session = yield* service.open(
            "mpv",
            () => true,
            () => {},
          );
          const first = yield* session.execute(load("one", "replace")).pipe(Effect.forkChild);
          const a = yield* Queue.take(writes);
          const second = yield* session.execute(load("two", "insert-at", 1)).pipe(Effect.forkChild);
          const b = yield* Queue.take(writes);
          yield* Queue.offer(lines, JSON.stringify({ request_id: b.request_id, error: "success", data: { playlist_entry_id: 22 } }));
          yield* Queue.offer(lines, JSON.stringify({ request_id: a.request_id, error: "success", data: { playlist_entry_id: 11 } }));
          expect((yield* Fiber.join(first)).playlist_entry_id).toBe(11);
          expect((yield* Fiber.join(second)).playlist_entry_id).toBe(22);
          const timeout = yield* session.execute(command("stop")).pipe(Effect.result, Effect.forkChild);
          const missing = yield* Queue.take(writes);
          yield* TestClock.adjust("5 seconds");
          expect((yield* Fiber.join(timeout))._tag).toBe("Failure");
          yield* Queue.offer(lines, JSON.stringify({ request_id: missing.request_id, error: "success" }));
          expect((yield* session.execute(command("stop")).pipe(Effect.result))._tag).toBe("Failure");
        }).pipe(Effect.provide(MpvSessionLive("ipc").pipe(Layer.provide(connection)))),
      );
      expect(closed).toBe(1);
    }),
  );
});
