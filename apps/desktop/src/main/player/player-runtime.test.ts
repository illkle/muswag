import { it } from "@effect/vitest";
import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";
import { MemoryMirror } from "@muswag/tanstack-db-mirror/server/memory";
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import type { PlayerCommand } from "#shared/commands/player";
import { EngineError } from "./errors";
import { player as playerTable, playerPosition } from "#shared/state/player";
import { Player } from "./player";
import { fixture, login, tracks, until } from "./test/player-harness";

const select = (key: string, positionSeconds = 0, items = tracks): PlayerCommand => ({ _tag: "ApplyQueue", items, select: { key, play: true, positionSeconds } });
const edit = (items = tracks): PlayerCommand => ({ _tag: "ApplyQueue", items, select: null });
/** Runs after everything posted before it has been handled. */
const barrier: PlayerCommand = { _tag: "SetMuted", muted: false };

describe("Effect player", () => {
  it.effect("commits a duplicate-media queue while events arrive before replies; restores only after load", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("b", 12));
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      expect(test.commands.filter((command) => command[0] === "loadfile")).toHaveLength(3);
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
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing" && !state.playback.buffering);
      yield* player.execute({ _tag: "Seek", seconds: 1800 });
      test.emit({ type: "property", name: "seeking", data: true });
      yield* until(player, (state) => state.playback._tag === "Playing" && state.playback.buffering);
      yield* player.execute({ _tag: "Pause" });
      expect((yield* player.snapshot).playback._tag).toBe("Paused");
      yield* player.execute({ _tag: "Play" });
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
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      expect(yield* mirror.get(playerTable, "player")).toMatchObject({ status: "playing", item: { key: "a" }, buffering: false, error: null });

      const batches: MirrorChangeBatch[] = [];
      const unsubscribe = mirror.subscribe((batch) => batches.push(batch));
      test.emit({ type: "property", name: "time-pos", data: 12 });
      yield* until(player, (state) => state.playback._tag === "Playing" && state.playback.media.positionSeconds === 12);
      unsubscribe();
      expect(batches.flatMap((batch) => batch.changes.map((change) => change.table))).toEqual(["player_position"]);
      expect(yield* mirror.get(playerPosition, "player")).toEqual({ id: "player", positionSeconds: 12, durationSeconds: null });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("tells the sender and the user why a command failed, until a track loads", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      const mirror = yield* MemoryMirror;
      yield* login(player);
      yield* player.execute(select("a"));
      const failed = yield* player.execute({ _tag: "Seek", seconds: 5 }).pipe(Effect.flip);
      expect(failed.message).toBe("Wait until the track has loaded.");
      // The command did nothing, so playback goes on; the error is only shown.
      expect(yield* mirror.get(playerTable, "player")).toMatchObject({ status: "loading", error: { message: "Wait until the track has loaded.", fix: null } });

      test.emit({ type: "file-loaded" });
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).error).toBeNull();
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("idle volume preferences do not acquire mpv; a session is given them, and nothing reads them back", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* player.execute({ _tag: "SetVolume", percent: 37 });
      expect(yield* player.snapshot).toMatchObject({ volumePercent: 37, muted: false });
      expect(test.generation).toBe(0);

      yield* login(player);
      yield* player.execute(select("a"));
      expect(test.commands).toContainEqual(["set_property", "volume", 37]);
      yield* player.execute({ _tag: "SetVolume", percent: 60 });
      expect(test.commands.at(-1)).toEqual(["set_property", "volume", 60]);
      expect((yield* player.snapshot).volumePercent).toBe(60);
      expect(test.commands.some((command) => command[0] === "get_property" && (command[1] === "volume" || command[1] === "mute"))).toBe(false);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a failed restore seek is visible and never reports playing", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a", 12));
      test.override((command) => (command.name === "seek" ? Effect.fail(new EngineError({ reason: "rejected", operation: "seek", uncertain: false })) : undefined));
      test.emit({ type: "file-loaded" });
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      expect(failed).toMatchObject({ playback: { reason: "player" }, error: { message: "The playback engine could not complete the operation.", fix: "retry" } });
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("stop waits for the queue request in flight, and old events cannot resurrect playback", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      const started = yield* Deferred.make<void>();
      test.override((command) => (command.name === "loadfile" ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : undefined));
      const selection = yield* player.execute(select("a")).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const stopped = yield* player.execute({ _tag: "Stop" }).pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(selection))._tag).toBe("Failure");
      yield* Fiber.join(stopped);
      test.emit({ type: "file-loaded" }, 1);
      yield* player.execute(barrier);
      // Stopping leaves nothing to act on, so what the request failed with is gone as well.
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Idle" }, error: null });
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a check for mpv that a stop arrives during still ends with its result", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      const gate = yield* Deferred.make<void>();
      test.holdProbes(Deferred.await(gate));
      const recheck = yield* player.execute({ _tag: "RefreshBinary" }).pipe(Effect.forkChild);
      yield* until(player, (state) => state.binary._tag === "Checking");
      const stopped = yield* player.execute({ _tag: "Stop" }).pipe(Effect.forkChild);
      const loggedOut = yield* player.setCredentials(null).pipe(Effect.forkChild);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(recheck);
      yield* Fiber.join(stopped);
      yield* Fiber.join(loggedOut);
      expect((yield* player.snapshot).binary._tag).toBe("Ready");
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("selects another occurrence in the running session, ignoring what mpv still reports about the one it leaves", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      const [a, b] = [test.currentId, test.currentId + 1];
      const seen: string[] = [];
      yield* Stream.runForEach(player.changes, (state) => Effect.sync(() => seen.push(state.playback._tag === "Idle" ? "" : state.playback.media.item.key))).pipe(Effect.forkChild);

      // mpv advanced to "b" by itself just as the selection reached it: neither that start nor its load is the selected one.
      test.override((command) => {
        if (command.name !== "playlist-play-index") return undefined;
        test.emit({ type: "end-file", entryId: a, reason: "eof" }, a);
        test.emit({ type: "start-file", entryId: b }, b);
        test.emit({ type: "file-loaded" }, b);
        return undefined;
      });
      yield* player.execute(select("c"));
      yield* player.execute(barrier);
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
      yield* player.execute(select("a"));
      const a = test.currentId;
      yield* player.execute(select("b"));
      yield* player.execute(select("c"));
      // "a" finishing its load late is not "c" starting.
      test.emit({ type: "file-loaded" }, a);
      yield* player.execute(barrier);
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "c" } } });
      test.emit({ type: "file-loaded" });
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).playback).toMatchObject({ media: { item: { key: "c" } } });
      expect(test.commands.filter((command) => command[0] === "loadfile")).toHaveLength(3);
      expect(test.generation).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("follows mpv into the next track by itself, from its start", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a", 30));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      const [a, b] = [test.currentId, test.currentId + 1];
      const seeks = () => test.commands.filter((command) => command[0] === "seek").length;
      const before = seeks();

      test.emit({ type: "end-file", entryId: a, reason: "eof" }, a);
      test.emit({ type: "start-file", entryId: b }, b);
      expect((yield* until(player, (state) => state.playback._tag === "Loading")).playback).toMatchObject({ media: { item: { key: "b" }, positionSeconds: 0 }, targetPaused: false });
      test.emit({ type: "file-loaded" }, b);
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).playback).toMatchObject({ media: { item: { key: "b" } } });
      expect(seeks()).toBe(before);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("restarts the loaded track by seeking, and replays an ended one without a new session", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("c"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      yield* player.execute({ _tag: "Seek", seconds: 40 });
      const before = test.commands.length;

      yield* player.execute({ _tag: "Restart" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Playing", media: { positionSeconds: 0 } });
      expect(test.commands.slice(before).map((command) => command[0])).not.toContain("loadfile");
      expect(test.commands.slice(before)).toContainEqual(["seek", 0, "absolute+exact"]);

      test.emit({ type: "end-file", entryId: test.currentId, reason: "eof" });
      yield* until(player, (state) => state.playback._tag === "Ended");
      yield* player.execute({ _tag: "Play" });
      expect(test.commands.at(-2)).toEqual(["playlist-play-index", 2]);
      // An ended track starts over, whatever position it ended at.
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { positionSeconds: 0 } });
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
      yield* player.execute(select("a"));
      const oldGeneration = test.generation;
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute(barrier);
      expect(test.generation).toBe(oldGeneration + 1);
      test.emit({ type: "file-loaded" }, test.currentId, oldGeneration);
      yield* player.execute(barrier);
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      // The track is what failed, which is what lets the queue move on from it.
      expect(failed).toMatchObject({ playback: { reason: "track" }, error: { message: "The track could not be played after retrying.", fix: "retry" } });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a failed track's error goes when another is selected, and stays when a command is only refused", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute(barrier);
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Failed");

      // A seek that is refused is told to whoever asked. The banner keeps the error that has a Retry.
      yield* player.execute({ _tag: "Seek", seconds: 5 }).pipe(Effect.flip);
      expect((yield* player.snapshot).error).toMatchObject({ message: "The track could not be played after retrying.", fix: "retry" });

      // The next track is not what failed: while it loads there is nothing to retry.
      yield* player.execute(select("b"));
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Loading", media: { item: { key: "b" } } }, error: null });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("play after a failure goes on from where the track had got to", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      yield* player.execute({ _tag: "Seek", seconds: 1800 });
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute(barrier);
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Failed");
      const before = test.commands.length;

      yield* player.execute({ _tag: "Play" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "a" }, positionSeconds: 1800 }, targetPaused: false });
      test.emit({ type: "file-loaded" });
      expect((yield* until(player, (state) => state.playback._tag === "Playing")).playback).toMatchObject({ media: { positionSeconds: 1800 } });
      expect(test.commands.slice(before)).toContainEqual(["seek", 1800, "absolute+exact"]);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a dismissed failure is no error any more, and play still starts the track", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      const mirror = yield* MemoryMirror;
      yield* login(player);
      yield* player.execute(select("a"));
      yield* TestClock.adjust("2 minutes");
      yield* until(player, (state) => state.playback._tag === "Failed");
      expect(yield* mirror.get(playerTable, "player")).toMatchObject({ status: "error", error: { fix: "retry" } });

      yield* player.execute({ _tag: "DismissError" });
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Stopped", media: { item: { key: "a" } } }, error: null });
      expect(yield* mirror.get(playerTable, "player")).toMatchObject({ status: "stopped", item: { key: "a" }, error: null });

      yield* player.execute({ _tag: "Play" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "a" } } });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("keeps a pause mpv reported by itself when the track is loaded again after an error", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      test.emit({ type: "property", name: "pause", data: true });
      yield* until(player, (state) => state.playback._tag === "Paused");

      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute(barrier);
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", targetPaused: true });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("rejects removal of the current occurrence before changing healthy playback", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      const before = test.commands.length;
      const result = yield* player.execute(edit(tracks.slice(1))).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect((yield* player.snapshot).playback._tag).toBe("Playing");
      expect(test.commands.length).toBe(before);
      expect(test.closes).toBe(0);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("keeps queue edits made after playback failed, for the selection that starts it again", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a", 0, tracks.slice(0, 2)));
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      yield* until(player, (state) => state.playback._tag === "Recovering");
      yield* player.execute(barrier);
      test.emit({ type: "end-file", entryId: test.currentId, reason: "error" });
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      const loads = () => test.commands.filter((command) => command[0] === "loadfile").length;
      const loaded = loads();

      // mpv is gone, so there is nothing to change: the queue is only kept.
      yield* player.execute(edit());
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Failed" }, error: failed.error });
      expect(loads()).toBe(loaded);
      // The occurrence that failed is what Play starts again, so the queue still has to hold it.
      expect((yield* player.execute(edit(tracks.slice(1))).pipe(Effect.result))._tag).toBe("Failure");

      yield* player.execute({ _tag: "Play" });
      expect((yield* player.snapshot).playback).toMatchObject({ _tag: "Loading", media: { item: { key: "a" } } });
      // All three occurrences of the kept queue, not the two it failed with.
      expect(loads()).toBe(loaded + 3);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("says what is wrong with mpv when it cannot be started, until mpv is found", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      test.failOpen(new EngineError({ reason: "spawn", operation: "connection", uncertain: true }));
      yield* player.execute(select("a")).pipe(Effect.result);
      // What the check for mpv found, with the way to put it right.
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Failed", reason: "player" }, error: { message: "Missing mpv", fix: "mpv" } });
      expect((yield* player.execute(select("a")).pipe(Effect.flip)).message).toBe("Missing mpv");

      test.failOpen(null);
      yield* player.execute({ _tag: "RefreshBinary" });
      // With mpv back nothing is wrong any more: the track only waits to be played.
      expect(yield* player.snapshot).toMatchObject({ binary: { _tag: "Ready" }, playback: { _tag: "Stopped", media: { item: { key: "a" } } }, error: null });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("a track selected without credentials is held as failed, and loads once they are set", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      expect((yield* player.execute(select("a", 30)).pipe(Effect.flip)).message).toBe("Log in before starting playback.");
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Failed", reason: "player", media: { item: { key: "a" } } }, error: { fix: "login" } });

      yield* login(player);
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Loading", media: { item: { key: "a" }, positionSeconds: 30 }, targetPaused: true }, error: null });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("stop after an event handler failed leaves nothing wrong behind", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a"));
      test.override((command) =>
        command.args[0] === "get_property" && command.args[1] === "pause" ? Effect.fail(new EngineError({ reason: "timeout", operation: "pause", uncertain: true })) : undefined,
      );
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Failed");

      yield* player.execute({ _tag: "Stop" });
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Idle" }, error: null });
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
  it.effect("keeps a track's stream URL across queue edits, so mpv's prefetch of it stays valid", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const player = yield* Player;
      yield* login(player);
      yield* player.execute(select("a", 0, tracks.slice(0, 2)));
      test.emit({ type: "file-loaded" });
      yield* until(player, (state) => state.playback._tag === "Playing");
      yield* player.execute(edit());
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
      expect((yield* player.execute(select("a")).pipe(Effect.result))._tag).toBe("Failure");
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
      yield* player.execute(select("a"));
      yield* TestClock.adjust("1 minute");
      expect((yield* player.snapshot).playback._tag).toBe("Loading");
      yield* TestClock.adjust("1 minute");
      const failed = yield* until(player, (state) => state.playback._tag === "Failed");
      expect(failed).toMatchObject({ playback: { reason: "track" }, error: { message: "The track did not finish loading.", fix: "retry" } });
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
      const selection = yield* player.execute(select("a")).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(selection)).message).toBe("The playback engine did not respond in time.");
      expect(yield* player.snapshot).toMatchObject({ playback: { _tag: "Failed", reason: "player" }, error: { message: "The playback engine did not respond in time." } });
      expect(test.closes).toBe(1);
      yield* player.shutdown;
    }).pipe(Effect.provide(test.layer));
  });
});
