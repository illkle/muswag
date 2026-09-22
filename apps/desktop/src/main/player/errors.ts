import { Cause, Data } from "effect";
import type { IssueCode, PlayerIssue } from "#shared/player-contract";

/** A failure talking to mpv. `uncertain` means mpv's state is unknown afterwards (e.g. a timeout mid-mutation). */
export class EngineError extends Data.TaggedError("EngineError")<{
  readonly reason: "spawn" | "connect" | "closed" | "timeout" | "protocol" | "rejected";
  readonly operation: string;
  readonly uncertain: boolean;
}> {}
/** A settings file could not be read or written. */
export class SettingsError extends Data.TaggedError("SettingsError")<{ readonly operation: "load" | "save" }> {}

type Failure = { readonly operation: string; readonly message: string };
/** Malformed input, or a request that makes no sense in the current state. */
export class InvalidCommand extends Data.TaggedError("InvalidCommand")<Failure> {}
export class NotAuthenticated extends Data.TaggedError("NotAuthenticated")<Failure> {}
export class BinaryUnavailable extends Data.TaggedError("BinaryUnavailable")<Failure> {}
/** Cancelled by a later Stop or logout. */
export class CommandRejected extends Data.TaggedError("CommandRejected")<Failure> {}
/** mpv's playlist no longer matches what the player believes it contains. */
export class QueueOutOfSync extends Data.TaggedError("QueueOutOfSync")<Failure> {}
export class InstallFailed extends Data.TaggedError("InstallFailed")<Failure> {}
export class SettingsFailed extends Data.TaggedError("SettingsFailed")<Failure> {}
export class Busy extends Data.TaggedError("Busy")<Failure> {}
export class ShuttingDown extends Data.TaggedError("ShuttingDown")<Failure> {}
export class InternalError extends Data.TaggedError("InternalError")<Failure> {}
export type PlayerError = InvalidCommand | NotAuthenticated | BinaryUnavailable | CommandRejected | QueueOutOfSync | InstallFailed | SettingsFailed | Busy | ShuttingDown | InternalError;
const playerErrors = [InvalidCommand, NotAuthenticated, BinaryUnavailable, CommandRejected, QueueOutOfSync, InstallFailed, SettingsFailed, Busy, ShuttingDown, InternalError];
export const isPlayerError = (value: unknown): value is PlayerError => playerErrors.some((type) => value instanceof type);

/** How a player command fails publicly: with the issue it produced, which the snapshot records as well. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly issue: PlayerIssue }> {}

const retryable = ["retry", "dismiss"] as const;
const actionsByCode: Record<IssueCode, PlayerIssue["actions"]> = {
  NotAuthenticated: ["login"],
  BinaryUnavailable: ["configureMpv", "refreshMpv"],
  SettingsFailed: ["dismiss"],
  InvalidCommand: ["dismiss"],
  ShuttingDown: ["dismiss"],
  InternalError: ["dismiss"],
  EngineUnavailable: retryable,
  CommandRejected: retryable,
  PlaybackFailed: retryable,
  QueueOutOfSync: retryable,
  InstallFailed: retryable,
  Busy: retryable,
};
export const issue = (code: IssueCode, operation: string, message: string, occurrenceKey: string | null = null): PlayerIssue => ({
  id: crypto.randomUUID(),
  code,
  operation,
  message,
  occurrenceKey,
  actions: actionsByCode[code],
});

/** Converts a failure into the issue shown to the user. Engine failures are attributed to `occurrenceKey`. */
export const toIssue = (error: PlayerError | EngineError, operation: string = error.operation, occurrenceKey: string | null = null): PlayerIssue => {
  if (error._tag !== "EngineError") return issue(error._tag, error.operation, error.message);
  return issue(
    error.reason === "rejected" && !error.uncertain ? "CommandRejected" : "EngineUnavailable",
    operation,
    error.reason === "timeout" ? "The playback engine did not respond in time." : "The playback engine could not complete the operation.",
    occurrenceKey,
  );
};

// Never log native Error objects: they can contain signed URLs, credentials or mpv arguments.
export const safeFailure = (error: unknown): Record<string, string> => {
  if (error instanceof EngineError) return { tag: error._tag, reason: error.reason, operation: error.operation };
  if (error instanceof SettingsError) return { tag: error._tag, operation: error.operation };
  if (error instanceof CommandFailed) return { tag: error._tag, code: error.issue.code, operation: error.issue.operation };
  if (isPlayerError(error)) return { tag: error._tag, operation: error.operation };
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
