import { Cause, Data } from "effect";
import type { PlayerIssue } from "#shared/player-contract";

export const MINIMUM_MPV_VERSION = [0, 41, 0] as const;
export class EngineError extends Data.TaggedError("EngineError")<{
  readonly reason: "spawn" | "connect" | "closed" | "timeout" | "protocol" | "rejected";
  readonly operation: string;
  readonly uncertain: boolean;
}> {}
export class SettingsError extends Data.TaggedError("SettingsError")<{ readonly operation: "load" | "save" }> {}
export class PlayerError extends Data.TaggedError("PlayerError")<{ readonly issue: PlayerIssue }> {}
export const issue = (code: PlayerIssue["code"], operation: string, message: string, occurrenceKey: string | null = null): PlayerIssue => ({
  id: crypto.randomUUID(),
  code,
  operation,
  message,
  occurrenceKey,
  actions:
    code === "NotAuthenticated"
      ? ["login"]
      : code === "BinaryUnavailable"
        ? ["configureMpv", "refreshMpv"]
        : ["SettingsFailed", "InvalidCommand", "ShuttingDown", "InternalError"].includes(code)
          ? ["dismiss"]
          : ["retry", "dismiss"],
});
export const playerError = (code: PlayerIssue["code"], operation: string, message: string) => new PlayerError({ issue: issue(code, operation, message) });
// Never log native Error objects: they can contain signed URLs, credentials or mpv arguments.
export const safeFailure = (error: unknown): Record<string, string> => {
  if (error instanceof EngineError) return { tag: error._tag, reason: error.reason, operation: error.operation };
  if (error instanceof PlayerError) return { tag: error._tag, code: error.issue.code, operation: error.issue.operation };
  if (error instanceof SettingsError) return { tag: error._tag, operation: error.operation };
  if (error instanceof Error)
    return {
      tag: "Defect",
      name: error.name,
      frames: (error.stack ?? "")
        .split("\n")
        .filter((line) => line.trimStart().startsWith("at "))
        .map((line) => line.replace(/https?:\/\/\S+/g, "[url]"))
        .join("\n"),
    };
  return { tag: "Defect" };
};

/** Retain the cause structure and code locations without dumping error messages/data. */
export const safeCause = (cause: Cause.Cause<unknown>) =>
  cause.reasons.map((reason) => (reason._tag === "Fail" ? safeFailure(reason.error) : reason._tag === "Die" ? safeFailure(reason.defect) : { tag: "Interrupted" }));
