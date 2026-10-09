import { Context, Effect, Layer } from "effect";
import type { BinaryState } from "#shared/commands/player";
import type { MpvInstallMethod } from "#shared/commands/player";
import { detectInstallCandidates, type MpvInstallCandidate } from "./install-catalog";
import { collectMpvCandidates, createMpvLocatorDeps, probeLoginShell, type MpvCandidate, type MpvLocatorDeps } from "./mpv-locator";
import { validateMpvBinary } from "./mpv-validator";

export class Binaries extends Context.Service<
  Binaries,
  {
    readonly resolve: (manualPath: string | null, cachedPath: string | null) => Effect.Effect<BinaryState>;
    readonly candidate: (method: MpvInstallMethod) => Effect.Effect<MpvInstallCandidate | null>;
  }
>()("@muswag/player/Binaries") {}

/** A candidate as the user is told about it: by whom it was named, or where it was found. */
const describeCandidate = ({ binaryPath, source }: MpvCandidate): string => {
  if (source === "env") return `MUSWAG_MPV_PATH (${binaryPath})`;
  if (source === "manual") return `The mpv you selected (${binaryPath})`;
  return source === "path" ? "The mpv on PATH" : `The mpv at ${binaryPath}`;
};

export const makeBinaries = (environment: MpvLocatorDeps): typeof Binaries.Service => ({
  /**
   * The first candidate that runs and is new enough, tried in order, so that an mpv which is where it
   * was last time costs one version check. A binary named by the user or the environment is the only
   * one tried: it is never replaced by one the app finds itself.
   */
  resolve: Effect.fn("Binaries.resolve")(
    function* (manualPath: string | null, cachedPath: string | null) {
      const tried = new Set<string>();
      /** Why the first binary that was turned down cannot be used. */
      let rejected: string | null = null;
      const attempt = Effect.fnUntraced(function* (candidate: MpvCandidate) {
        if (tried.has(candidate.binaryPath)) return null;
        tried.add(candidate.binaryPath);
        const validation = yield* validateMpvBinary(candidate.binaryPath, environment);
        if (validation.ok) return { _tag: "Ready" as const, path: candidate.binaryPath, version: validation.version, source: candidate.source };
        // A place the app only guessed at and found empty is not worth a word, nor is a remembered binary that has gone or changed.
        if (candidate.explicit || (!validation.missing && candidate.source !== "cache")) rejected ??= `${describeCandidate(candidate)} cannot be used. ${validation.reason}`;
        return null;
      });
      const unavailable = Effect.fnUntraced(function* () {
        const options = (yield* detectInstallCandidates(environment)).map((candidate) => candidate.option);
        return { _tag: "Unavailable" as const, message: rejected ?? "mpv was not found. Install it, or select its executable.", options };
      });

      for (const candidate of yield* collectMpvCandidates({ manualPath, cachedPath }, environment)) {
        const ready = yield* attempt(candidate);
        if (ready) return ready;
        if (candidate.explicit) return yield* unavailable();
      }
      const shellPath = yield* probeLoginShell("mpv", environment);
      return (shellPath ? yield* attempt({ binaryPath: shellPath, explicit: false, source: "login-shell" }) : null) ?? (yield* unavailable());
    },
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.succeed<BinaryState>({ _tag: "Unavailable", message: "Checking mpv timed out.", options: [] }),
    }),
  ),
  candidate: (method) => detectInstallCandidates(environment).pipe(Effect.map((candidates) => candidates.find((candidate) => candidate.option.method === method) ?? null)),
});
export const BinariesLive = Layer.effect(Binaries, createMpvLocatorDeps.pipe(Effect.map(makeBinaries)));
