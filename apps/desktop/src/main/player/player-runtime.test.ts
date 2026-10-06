import { it } from "@effect/vitest";
import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";
import { MemoryMirror } from "@muswag/tanstack-db-mirror/server/memory";
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { EngineError } from "./errors";
import { player as playerTable, playerIssues, playerPosition } from "#shared/state/player";
import { Player } from "./player";
import { fixture, login, tracks, until } from "./test/player-harness";

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
  it.effect("reports buffering while mpv is seeking or refilling its cache, but only when playing", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing" && !state.playback.buffering);
      yield* player.execute("seek", { _tag: "Seek", seconds: 1800 });
      test.emit({ type: "property", name: "seeking", data: true });
      yield* until(player, (state) => state.playback._tag === "Playing" && state.playback.buffering);
      yield* player.execute("pause", { _tag: "Pause" });
      expect((yield* player.snapshot).playback._tag).toBe("Paused");
      yield* player.execute("play", { _tag: "Play" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Playing", buffering: true });
      test.emit({ type: "property", name: "seeking", data: false });
      yield* until(player, (state) => state.playback._tag === "Playing" && !state.playback.buffering);
      test.emit({ type: "property", name: "paused-for-cache", data: true });
      yield* until(player, (state) => state.playback._tag === "Playing" && state.playback.buffering);
      test.emit({ type: "property", name: "paused-for-cache", data: undefined });
      yield* until(player, (state) => state.playback._tag === "Playing" && !state.playback.buffering);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("mirrors its state for renderers, with position updates apart from everything else", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      const mirror = yield* MemoryMirror;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      expect(yield* mirror.get(playerTable, "player")).toMatchObject({ playback: { _tag: "Playing", item: { key: "a" }, buffering: false }, pending: null });

      const batches: MirrorChangeBatch[] = [];
      const unsubscribe = mirror.subscribe((batch) => batches.push(batch));
      test.emit({ type: "property", name: "time-pos", data: 12 });
      yield* until(player, (state) => state.playback._tag === "Playing" && state.playback.media.positionSeconds === 12);
      unsubscribe();
      expect(batches.flatMap((batch) => batch.changes.map((change) => change.table))).toEqual(["player_position"]);
      expect(yield* mirror.get(playerPosition, "player")).toEqual({ id: "player", positionSeconds: 12, durationSeconds: null });

      const failed = yield* player
        .execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "b", play: true, positionSeconds: 0 } })
        .pipe(Effect.andThen(player.execute("seek-while-loading", { _tag: "Seek", seconds: 5 })), Effect.flip, Effect.option);
      expect(failed._tag).toBe("Some");
      const issues = yield* mirror.rows(playerIssues);
      expect(issues.map(({ code, order }) => [code, order])).toEqual([["InvalidCommand", 0]]);
      yield* player.shutdown;
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
  it.effect("selects another occurrence in the running session, ignoring what mpv still reports about the one it leaves", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      const [a, b] = [test.currentId, test.currentId + 1];
      const seen: string[] = [];
      yield* Stream.runForEach(player.changes, (state) => Effect.sync(() => seen.push(state.playback._tag === "Idle" ? "" : (state.playback.media?.item.key ?? "")))).pipe(Effect.forkChild);

      // mpv advanced to "b" by itself just as the selection reached it: neither that start nor its load is the selected one.
      test.override((command) => {
        if (command.name !== "playlist-play-index") return undefined;
        test.emit({ type: "end-file", entryId: a, reason: "eof" }, a);
        test.emit({ type: "start-file", entryId: b }, b);
        test.emit({ type: "file-loaded" }, b);
        return undefined;
      });
      yield* player.execute("next", { _tag: "ApplyQueue", items: tracks, select: { key: "c", play: true, positionSeconds: 0 } });
      yield* player.execute("barrier", { _tag: "SetVolume", percent: 10 });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "c" } } });
      test.emit({ type: "file-loaded" });
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).playback).toMatchObject({ media: { item: { key: "c" } } });
      expect(seen).not.toContain("b");
      expect(test.commands.filter((command) => command[0] === "loadfile")).toHaveLength(3);
      expect(test.generation).toBe(1);
      expect(test.closes).toBe(0);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("selects another occurrence while the one selected before it is still loading", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "a", play: true, positionSeconds: 0 } });
      const a = test.currentId;
      yield* player.execute("next", { _tag: "ApplyQueue", items: tracks, select: { key: "b", play: true, positionSeconds: 0 } });
      yield* player.execute("next", { _tag: "ApplyQueue", items: tracks, select: { key: "c", play: true, positionSeconds: 0 } });
      // "a" finishing its load late is not "c" starting.
      test.emit({ type: "file-loaded" }, a);
      yield* player.execute("barrier", { _tag: "SetVolume", percent: 10 });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "c" } } });
      test.emit({ type: "file-loaded" });
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).playback).toMatchObject({ media: { item: { key: "c" } } });
      expect(test.commands.filter((command) => command[0] === "loadfile")).toHaveLength(3);
      expect(test.generation).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("restarts the loaded track by seeking, and replays an ended one without a new session", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks, select: { key: "c", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      yield* player.execute("seek", { _tag: "Seek", seconds: 40 });
      const before = test.commands.length;

      yield* player.execute("restart", { _tag: "Restart" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Playing", media: { positionSeconds: 0 } });
      expect(test.commands.slice(before).map((command) => command[0])).not.toContain("loadfile");
      expect(test.commands.slice(before)).toContainEqual(["seek", 0, "absolute+exact"]);

      test.emit({ type: "end-file", entryId: test.currentId, reason: "eof" });
      yield* until(player, (state) => state.playback._tag === "Ended");
      yield* player.execute("play", { _tag: "Play" });
      expect(test.commands.at(-2)).toEqual(["playlist-play-index", 2]);
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      expect(test.generation).toBe(1);
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
  it.effect("keeps a track's stream URL across queue edits, so mpv's prefetch of it stays valid", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute("select", { _tag: "ApplyQueue", items: tracks.slice(0, 2), select: { key: "a", play: true, positionSeconds: 0 } });
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      yield* player.execute("edit", { _tag: "ApplyQueue", items: tracks, select: null });
      // The fixture's occurrences all play one track: two loads for the selection, one for the edit.
      const urls = test.commands.filter((command) => command[0] === "loadfile").map((command) => Redacted.value(command[1] as Redacted.Redacted<string>));
      expect(urls).toHaveLength(3);
      expect(new Set(urls).size).toBe(1);
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
      yield* TestClock.adjust("1 minute");
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      yield* TestClock.adjust("1 minute");
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
