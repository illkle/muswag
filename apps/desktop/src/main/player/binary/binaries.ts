import { Context, Effect, Layer } from "effect";
import type { BinaryState } from "#shared/player-contract";
import type { MpvInstallMethod } from "#shared/player";
import { issue } from "../errors";
import { detectInstallCandidates, type MpvInstallCandidate } from "./install-catalog";
import { collectMpvCandidates, createMpvLocatorDeps, type MpvLocatorDeps } from "./mpv-locator";
import { MINIMUM_MPV_VERSION, validateMpvBinary } from "./mpv-validator";

export class Binaries extends Context.Service<
  Binaries,
  {
    readonly resolve: (manualPath: string | null, cachedPath: string | null) => Effect.Effect<BinaryState>;
    readonly candidate: (method: MpvInstallMethod) => Effect.Effect<MpvInstallCandidate | null>;
  }
>()("@muswag/player/Binaries") {}
export const makeBinaries = (environment: MpvLocatorDeps): typeof Binaries.Service => ({
  resolve: Effect.fn("Binaries.resolve")(
    function* (manualPath: string | null, cachedPath: string | null) {
      const candidates = yield* collectMpvCandidates({ manualPath, cachedPath }, environment);
      let invalid = false;
      const seen = new Set<string>();
      for (const candidate of candidates) {
        if (seen.has(candidate.binaryPath)) continue;
        seen.add(candidate.binaryPath);
        const validation = yield* validateMpvBinary(candidate.binaryPath, environment);
        if (validation.ok) return { _tag: "Ready" as const, path: candidate.binaryPath, version: validation.version, source: candidate.source };
        if (candidate.explicit) {
          invalid = true;
          break;
        }
        if (!validation.missing && candidate.source !== "cache") invalid = true;
      }
      return {
        _tag: "Unavailable" as const,
        reason: invalid ? ("invalid" as const) : ("missing" as const),
        issue: issue("BinaryUnavailable", "discovery", invalid ? `The configured mpv cannot run or is older than ${MINIMUM_MPV_VERSION.join(".")}.` : "Install mpv or select its executable."),
        options: (yield* detectInstallCandidates(environment)).map((candidate) => candidate.option),
      };
    },
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.succeed<BinaryState>({ _tag: "Unavailable", reason: "probeFailed", issue: issue("BinaryUnavailable", "discovery", "Checking mpv timed out."), options: [] }),
    }),
  ),
  candidate: (method) => detectInstallCandidates(environment).pipe(Effect.map((candidates) => candidates.find((candidate) => candidate.option.method === method) ?? null)),
});
export const BinariesLive = Layer.effect(Binaries, createMpvLocatorDeps.pipe(Effect.map(makeBinaries)));
