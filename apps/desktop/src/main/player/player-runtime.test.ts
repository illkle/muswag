import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { EngineError } from "./errors";
import { Player } from "./player";
import { fixture, login, tracks, until } from "./test/player";

describe("Effect player", () => {
  it.effect("commits a duplicate-media queue while events arrive before replies; restores only after load", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "b", play: true, positionSeconds: 12 } });
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      expect((yield* player.snapshot).queue.keys).toEqual(["a", "b", "c"]);
      expect(test.commands.some((command) => command[0] === "seek")).toBe(false);
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      expect(test.commands).toContainEqual(["seek", 12, "absolute+exact"]);
      yield* player.shutdown;
      expect(test.closes).toBe(1);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("idle volume preferences do not acquire mpv", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* player.execute("volume", { _tag: "SetVolume", percent: 37 });
      expect((yield* player.snapshot).audio).toEqual({ volumePercent: 37, muted: false, applied: false });
      expect(test.generation).toBe(0);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a failed restore seek is visible and never reports playing", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 12 } });
      test.override((command) => (command.name === "seek" ? Effect.fail(new EngineError({ reason: "rejected", operation: "seek", uncertain: false })) : undefined));
      test.emit({ type: "file-loaded" });
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      expect(failed.issues.at(-1)?.code).toBe("CommandRejected");
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("stop interrupts an in-flight queue request and old events cannot resurrect playback", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      const started = yield* Deferred.make<void>();
      test.override((command) => (command.name === "loadfile" ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : undefined));
      const selection = yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } }).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      yield* player.execute("stop", { _tag: "Stop" });
      expect((yield* Fiber.join(selection))._tag).toBe("Failure");
      test.emit({ type: "file-loaded" }, 1);
      yield* player.execute("barrier", { _tag: "SetVolume", percent: 30 });
      expect((yield* player.snapshot).playback._tag).toBe("Idle");
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("retries media once with a new session and ignores stale generation events", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      const oldGeneration = test.generation;
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute("barrier", { _tag: "SetVolume", percent: 10 });
      expect(test.generation).toBe(oldGeneration + 1);
      test.emit({ type: "file-loaded" }, test.currentId, oldGeneration);
      yield* player.execute("barrier2", { _tag: "SetVolume", percent: 20 });
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      expect((yield* until(player, (state) => state.playback._tag === "Failed")).issues.at(-1)?.code).toBe("PlaybackFailed");
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("rejects removal of the current occurrence before changing healthy playback", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      const before = test.commands.length;
      const result = yield* player.execute("bad-edit", { _tag: "ApplyQueue", items: tracks.slice(1), select: null }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect((yield* player.snapshot).playback._tag).toBe("Playing");
      expect(test.commands.length).toBe(before);
      expect(test.closes).toBe(0);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("rechecks availability when the resolved executable disappears", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      test.failOpen(new EngineError({ reason: "spawn", operation: "connection", uncertain: true }));
      expect((yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } }).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* player.snapshot).binary._tag).toBe("Unavailable");
      expect(test.probes).toBe(2);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("fails playback when the selected track never finishes loading", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      yield* TestClock.adjust("20 seconds");
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      expect(failed.issues.at(-1)).toMatchObject({ code: "PlaybackFailed", operation: "load" });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a queue mutation that never completes times out and fails closed", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      const started = yield* Deferred.make<void>();
      test.override((command) => (command.name === "loadfile" ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : undefined));
      const selection = yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(selection)).issue.code).toBe("EngineUnavailable");
      expect((yield* player.snapshot).playback._tag).toBe("Failed");
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
});
