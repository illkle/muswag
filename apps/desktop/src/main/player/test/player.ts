import { Effect, Layer, Queue, Redacted, Stream } from "effect";
import type { PlaybackItem } from "@muswag/shared";
import type { PlayerSnapshot } from "#shared/player-contract";
import { Binaries } from "../binary/binaries";
import { Installer } from "../binary/installer";
import { EngineError, issue } from "../errors";
import { isPositionEvent, MpvSession, type SessionEvent, type SessionSinks } from "../mpv/session";
import type { MpvCommand, MpvEvent } from "../mpv/protocol";
import { PlayerLive, type PlayerService } from "../player";
import { SettingsStore, defaultSettings } from "../settings";

export const tracks: PlaybackItem[] = ["a", "b", "c"].map((key) => ({ key, track: { id: "same-track", title: key, isDir: false } }));

/** A PlayerLive wired to an in-memory mpv that records commands and lets tests inject events. */
export function fixture() {
  let sinks: SessionSinks | null = null;
  let generation = 0;
  let sequence = 0;
  let nextId = 0;
  let playlist: { id: number; current: boolean }[] = [];
  let paused = false;
  let position = 0;
  let closes = 0;
  let probes = 0;
  let openFailure: EngineError | null = null;
  const commands: unknown[][] = [];
  let override: ((command: MpvCommand<unknown>) => Effect.Effect<unknown, EngineError> | undefined) | undefined;
  const deliver = (event: MpvEvent, entryId: number | null, gen = generation) => {
    const stamped: SessionEvent = { _tag: "SessionEvent", generation: gen, sequence: ++sequence, entryId, event };
    if (sinks) Queue.offerUnsafe(isPositionEvent(stamped) ? sinks.positions : sinks.events, stamped);
  };

  const session = Layer.succeed(MpvSession, {
    open: (_binary, next) =>
      Effect.gen(function* () {
        if (openFailure) return yield* openFailure;
        generation++;
        sinks = next;
        playlist = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closes++;
          }),
        );
        return {
          generation,
          sequence: () => sequence,
          failure: Effect.never,
          execute: <A>(input: MpvCommand<A>) =>
            Effect.gen(function* () {
              commands.push([...input.args]);
              sequence++;
              const custom = override?.(input);
              if (custom) return (yield* custom) as A;
              const [name, arg, mode, index] = input.args;
              let result: unknown;
              if (name === "loadfile") {
                const entry = { id: ++nextId, current: mode === "replace" };
                if (mode === "replace") {
                  playlist = [entry];
                  deliver({ type: "start-file", entryId: entry.id }, entry.id);
                } else playlist.splice(index as number, 0, entry);
                result = { playlist_entry_id: entry.id };
              } else if (name === "get_property" && arg === "playlist") result = playlist;
              else if (name === "get_property" && arg === "pause") result = paused;
              else if (name === "get_property" && arg === "time-pos") result = position;
              else if (name === "get_property" && arg === "volume") result = 50;
              else if (name === "get_property" && arg === "mute") result = false;
              else if (name === "set_property" && arg === "pause") paused = mode as boolean;
              else if (name === "seek") position = arg as number;
              else if (name === "playlist-clear") playlist = playlist.filter((entry) => entry.current);
              return yield* input.decode(result);
            }),
        };
      }),
  });
  const layer = PlayerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        session,
        Layer.succeed(Binaries, {
          resolve: () =>
            Effect.sync(() => {
              probes++;
              return openFailure
                ? { _tag: "Unavailable" as const, reason: "missing" as const, issue: issue("BinaryUnavailable", "discovery", "Missing mpv"), options: [] }
                : { _tag: "Ready" as const, path: "/mpv", version: "0.41.0", source: "manual" as const };
            }),
          candidate: () => Effect.succeed(null),
        }),
        Layer.succeed(Installer, { start: () => Effect.die("unused"), cancel: () => Effect.void, changes: Stream.empty }),
        Layer.succeed(SettingsStore, { load: Effect.succeed(defaultSettings), save: () => Effect.void }),
      ),
    ),
  );
  const currentId = () => playlist.find((entry) => entry.current)?.id ?? null;
  return {
    layer,
    commands: commands as readonly (readonly unknown[])[],
    failOpen: (error: EngineError) => {
      openFailure = error;
    },
    get probes() {
      return probes;
    },
    get closes() {
      return closes;
    },
    get generation() {
      return generation;
    },
    get currentId() {
      return currentId() ?? 0;
    },
    emit: (event: MpvEvent, id = currentId(), gen = generation) => deliver(event, id, gen),
    override: (fn: typeof override) => {
      override = fn;
    },
  };
}
export const until = (player: PlayerService, predicate: (state: PlayerSnapshot) => boolean) =>
  player.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((states) => states[0]!),
  );
export const login = (player: PlayerService) => player.setCredentials({ url: "https://music.test", username: "me", password: Redacted.make("secret") });
