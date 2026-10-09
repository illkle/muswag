import { Cause, Data } from "effect";
import type { PlayerError } from "#shared/commands/player";

/** A failure talking to mpv. `uncertain` means mpv's state is unknown afterwards (e.g. a timeout mid-mutation). */
export class EngineError extends Data.TaggedError("EngineError")<{
  readonly reason: "spawn" | "connect" | "closed" | "timeout" | "protocol" | "rejected";
  readonly operation: string;
  readonly uncertain: boolean;
}> {}
/** A settings file could not be read or written. */
export class SettingsError extends Data.TaggedError("SettingsError")<{ readonly operation: "load" | "save" }> {}

type Failure = { readonly operation: string; readonly message: string };
/** A request that makes no sense in the current state. */
export class InvalidCommand extends Data.TaggedError("InvalidCommand")<Failure> {}
export class NotAuthenticated extends Data.TaggedError("NotAuthenticated")<Failure> {}
export class BinaryUnavailable extends Data.TaggedError("BinaryUnavailable")<Failure> {}
/** The current track could not be played: mpv gave up on it twice, or it never finished loading. */
export class PlaybackFailed extends Data.TaggedError("PlaybackFailed")<Failure> {}
/** mpv's playlist no longer matches what the player believes it contains. */
export class QueueOutOfSync extends Data.TaggedError("QueueOutOfSync")<Failure> {}
export class InstallFailed extends Data.TaggedError("InstallFailed")<Failure> {}
export class SettingsFailed extends Data.TaggedError("SettingsFailed")<Failure> {}
export class InternalError extends Data.TaggedError("InternalError")<Failure> {}
export type PlayerFailure = InvalidCommand | NotAuthenticated | BinaryUnavailable | PlaybackFailed | QueueOutOfSync | InstallFailed | SettingsFailed | InternalError;
const playerFailures = [InvalidCommand, NotAuthenticated, BinaryUnavailable, PlaybackFailed, QueueOutOfSync, InstallFailed, SettingsFailed, InternalError];
export const isPlayerFailure = (value: unknown): value is PlayerFailure => playerFailures.some((type) => value instanceof type);

/** How a command fails for whoever sent it. The player's state says the same to the user. */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{ readonly message: string }> {}

/** A failure as the user is told about it. */
export const describeFailure = (error: PlayerFailure | EngineError): PlayerError => {
  if (error._tag === "EngineError")
    return { message: error.reason === "timeout" ? "The playback engine did not respond in time." : "The playback engine could not complete the operation.", fix: null };
  return { message: error.message, fix: error._tag === "BinaryUnavailable" ? "mpv" : error._tag === "NotAuthenticated" ? "login" : null };
};

// Never log native Error objects: they can contain signed URLs, credentials or mpv arguments.
export const safeFailure = (error: unknown): Record<string, string> => {
  if (error instanceof EngineError) return { tag: error._tag, reason: error.reason, operation: error.operation };
  if (error instanceof SettingsError) return { tag: error._tag, operation: error.operation };
  if (isPlayerFailure(error)) return { tag: error._tag, operation: error.operation };
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
