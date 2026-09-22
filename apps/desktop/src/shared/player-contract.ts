import { Schema } from "effect";
import type { PlaybackItem } from "@muswag/shared";

/**
 * The wire contract between the main-process player and the renderer. Every type is derived from its schema,
 * so main decodes commands and the renderer decodes snapshots against the same definitions.
 */

const Key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

// ---- mpv discovery and installation ----

export const MpvInstallMethod = Schema.Literals(["brew", "winget", "scoop", "choco", "apt", "dnf", "pacman", "zypper", "flatpak"]);
export type MpvInstallMethod = typeof MpvInstallMethod.Type;
/** How the mpv binary in use was found. */
export const MpvSource = Schema.Literals(["env", "manual", "cache", "path", "well-known", "login-shell"]);
export type MpvSource = typeof MpvSource.Type;
export const MpvInstallOption = Schema.Struct({
  command: Schema.String,
  automatic: Schema.Boolean,
  method: MpvInstallMethod,
  note: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type MpvInstallOption = typeof MpvInstallOption.Type;

// ---- Queue items ----

const isPlayableTrack = (track: unknown): boolean => {
  const { id, title, isDir } = (track ?? {}) as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && typeof title === "string" && typeof isDir === "boolean";
};
/**
 * A queue occurrence. Declared rather than structural so the full shared Song payload passes through
 * untouched; only the fields playback relies on are checked.
 */
export const PlaybackItemSchema = Schema.declare(
  (input: unknown): input is PlaybackItem => {
    const { key, track } = (input ?? {}) as Record<string, unknown>;
    return typeof key === "string" && key.length > 0 && key.length <= 1024 && isPlayableTrack(track);
  },
  { expected: "a playback item with a key and a playable track" },
);

// ---- Commands ----

export const Selection = Schema.Struct({ key: Key, play: Schema.Boolean, positionSeconds: Seconds });
export type Selection = typeof Selection.Type;

/** Returns why a queue cannot be played, or undefined when it is valid. */
export const queueProblem = ({ items, select }: { readonly items: readonly PlaybackItem[]; readonly select: Selection | null }): string | undefined => {
  const keys = new Set(items.map((item) => item.key));
  if (keys.size !== items.length) return "Queue entries must have unique keys.";
  if (select && !keys.has(select.key)) return "Selected occurrence is not in the queue.";
  return undefined;
};

export const PlayerCommand = Schema.Union([
  Schema.TaggedStruct("ApplyQueue", {
    items: Schema.Array(PlaybackItemSchema).check(Schema.isMaxLength(1000)),
    select: Schema.NullOr(Selection),
  }).check(Schema.makeFilter(queueProblem)),
  ...(["Play", "Pause", "Toggle", "Restart", "Stop", "RefreshBinary"] as const).map((tag) => Schema.TaggedStruct(tag, {})),
  Schema.TaggedStruct("Seek", { seconds: Seconds }),
  Schema.TaggedStruct("SetVolume", { percent: Percent }),
  Schema.TaggedStruct("SetMuted", { muted: Schema.Boolean }),
  Schema.TaggedStruct("SetBinaryPath", { path: Schema.NullOr(Key) }),
  Schema.TaggedStruct("StartInstall", { method: MpvInstallMethod }),
  Schema.TaggedStruct("CancelInstall", { jobId: Key }),
  Schema.TaggedStruct("DismissIssue", { issueId: Key }),
]);
export type PlayerCommand = typeof PlayerCommand.Type;

/** Server credentials as main keeps them: the password is redacted so it cannot reach logs by accident. */
export const PlayerCredentials = Schema.Struct({ url: Key, username: Key, password: Schema.RedactedFromValue(Schema.String.check(Schema.isMaxLength(8192))) });
export type PlayerCredentials = typeof PlayerCredentials.Type;

// ---- Snapshots ----

export const IssueCode = Schema.Literals([
  "InvalidCommand",
  "NotAuthenticated",
  "BinaryUnavailable",
  "EngineUnavailable",
  "CommandRejected",
  "PlaybackFailed",
  "QueueOutOfSync",
  "InstallFailed",
  "SettingsFailed",
  "Busy",
  "ShuttingDown",
  "InternalError",
]);
export type IssueCode = typeof IssueCode.Type;
export const PlayerIssue = Schema.Struct({
  id: Schema.String,
  code: IssueCode,
  message: Schema.String,
  operation: Schema.String,
  occurrenceKey: Schema.NullOr(Schema.String),
  actions: Schema.Array(Schema.Literals(["retry", "login", "configureMpv", "refreshMpv", "dismiss"])),
});
export type PlayerIssue = typeof PlayerIssue.Type;

export const Media = Schema.Struct({ item: PlaybackItemSchema, positionSeconds: Seconds, durationSeconds: Schema.NullOr(Seconds) });
export type Media = typeof Media.Type;
export const Playback = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", { media: Media, targetPaused: Schema.Boolean }),
  Schema.TaggedStruct("Playing", { media: Media }),
  Schema.TaggedStruct("Paused", { media: Media }),
  Schema.TaggedStruct("Ended", { media: Media }),
  Schema.TaggedStruct("Recovering", { media: Media, attempt: Schema.Literal(1) }),
  Schema.TaggedStruct("Failed", { media: Schema.NullOr(Media), issue: PlayerIssue }),
]);
export type Playback = typeof Playback.Type;

export const BinaryState = Schema.Union([
  Schema.TaggedStruct("Checking", {}),
  Schema.TaggedStruct("Ready", { path: Schema.String, version: Schema.String, source: MpvSource }),
  Schema.TaggedStruct("Unavailable", { reason: Schema.Literals(["missing", "invalid", "probeFailed"]), issue: PlayerIssue, options: Schema.Array(MpvInstallOption) }),
]);
export type BinaryState = typeof BinaryState.Type;

const InstallJob = { jobId: Schema.String, method: MpvInstallMethod };
export const InstallState = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Running", InstallJob),
  Schema.TaggedStruct("Cancelling", InstallJob),
  Schema.TaggedStruct("Succeeded", InstallJob),
  Schema.TaggedStruct("Cancelled", InstallJob),
  Schema.TaggedStruct("Failed", { ...InstallJob, issue: PlayerIssue }),
]);
export type InstallState = typeof InstallState.Type;
export const InstallOutput = Schema.Struct({ jobId: Schema.String, sequence: Count, stream: Schema.Literals(["stdout", "stderr"]), line: Schema.String });
export type InstallOutput = typeof InstallOutput.Type;

export const Stamp = Schema.Struct({ epoch: Schema.String, revision: Count });
export type Stamp = typeof Stamp.Type;
export const PlayerSnapshot = Schema.Struct({
  stamp: Stamp,
  lifecycle: Schema.Literals(["running", "closing", "closed"]),
  playback: Playback,
  queue: Schema.Struct({ revision: Count, keys: Schema.Array(Schema.String), sync: Schema.Literals(["empty", "applying", "synced", "unknown"]) }),
  pending: Schema.NullOr(Schema.Struct({ commandId: Schema.String, kind: Schema.String })),
  audio: Schema.Struct({ volumePercent: Percent, muted: Schema.Boolean, applied: Schema.Boolean }),
  binary: BinaryState,
  install: InstallState,
  installOutput: Schema.Array(InstallOutput),
  issues: Schema.Array(PlayerIssue),
});
export type PlayerSnapshot = typeof PlayerSnapshot.Type;

export const CommandAck = Schema.Struct({ commandId: Schema.String, stamp: Stamp, jobId: Schema.NullOr(Schema.String) });
export type CommandAck = typeof CommandAck.Type;
export const CommandResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), ack: CommandAck, snapshot: PlayerSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), commandId: Schema.String, issue: PlayerIssue, snapshot: PlayerSnapshot }),
]);
export type CommandResult = typeof CommandResult.Type;

export const initialSnapshot = (epoch: string): PlayerSnapshot => ({
  stamp: { epoch, revision: 0 },
  lifecycle: "running",
  playback: { _tag: "Idle" },
  queue: { revision: 0, keys: [], sync: "empty" },
  pending: null,
  audio: { volumePercent: 100, muted: false, applied: false },
  binary: { _tag: "Checking" },
  install: { _tag: "Idle" },
  installOutput: [],
  issues: [],
});
