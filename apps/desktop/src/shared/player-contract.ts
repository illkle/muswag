import { Schema } from "effect";
import type { PlaybackItem } from "@muswag/shared";
import type { MpvInstallMethod, MpvInstallOption, MpvSource } from "./player";

const key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const method = Schema.Literals(["brew", "winget", "scoop", "choco", "apt", "dnf", "pacman", "zypper", "flatpak"]);
// Only playback's required metadata is trusted. Preserve the shared Song payload.
const item = Schema.Struct({ key, track: Schema.Unknown });
export const PlayerCommandSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("ApplyQueue"),
    items: Schema.Array(item).check(Schema.isMaxLength(1000)),
    select: Schema.NullOr(Schema.Struct({ key, play: Schema.Boolean, positionSeconds: seconds })),
  }),
  Schema.Struct({ _tag: Schema.Literals(["Play", "Pause", "Toggle", "Restart", "Stop", "RefreshBinary"]) }),
  Schema.Struct({ _tag: Schema.Literal("Seek"), seconds }),
  Schema.Struct({ _tag: Schema.Literal("SetVolume"), percent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })) }),
  Schema.Struct({ _tag: Schema.Literal("SetMuted"), muted: Schema.Boolean }),
  Schema.Struct({ _tag: Schema.Literal("SetBinaryPath"), path: Schema.NullOr(key) }),
  Schema.Struct({ _tag: Schema.Literal("StartInstall"), method }),
  Schema.Struct({ _tag: Schema.Literal("CancelInstall"), jobId: key }),
  Schema.Struct({ _tag: Schema.Literal("DismissIssue"), issueId: key }),
]);
export type Selection = { readonly key: string; readonly play: boolean; readonly positionSeconds: number };
export type PlayerCommand =
  | Exclude<typeof PlayerCommandSchema.Type, { _tag: "ApplyQueue" }>
  | { readonly _tag: "ApplyQueue"; readonly items: readonly PlaybackItem[]; readonly select: Selection | null };
export const CredentialsSchema = Schema.NullOr(Schema.Struct({ url: key, username: key, password: Schema.String.check(Schema.isMaxLength(8192)) }));
export type Stamp = { readonly epoch: string; readonly revision: number };
export type PlayerIssue = Readonly<{
  id: string;
  code:
    | "InvalidCommand"
    | "NotAuthenticated"
    | "BinaryUnavailable"
    | "EngineUnavailable"
    | "CommandRejected"
    | "PlaybackFailed"
    | "QueueOutOfSync"
    | "InstallFailed"
    | "SettingsFailed"
    | "Busy"
    | "ShuttingDown"
    | "InternalError";
  message: string;
  operation: string;
  occurrenceKey: string | null;
  actions: readonly ("retry" | "login" | "configureMpv" | "refreshMpv" | "dismiss")[];
}>;
export type Media = Readonly<{ item: PlaybackItem; positionSeconds: number; durationSeconds: number | null }>;
export type Playback =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly media: Media; readonly targetPaused: boolean }
  | { readonly _tag: "Playing" | "Paused" | "Ended"; readonly media: Media }
  | { readonly _tag: "Recovering"; readonly media: Media; readonly attempt: 1 }
  | { readonly _tag: "Failed"; readonly media: Media | null; readonly issue: PlayerIssue };
export type BinaryState =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Ready"; readonly path: string; readonly version: string; readonly source: MpvSource }
  | { readonly _tag: "Unavailable"; readonly reason: "missing" | "invalid" | "probeFailed"; readonly issue: PlayerIssue; readonly options: readonly MpvInstallOption[] };
export type InstallState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running" | "Cancelling" | "Succeeded" | "Cancelled"; readonly jobId: string; readonly method: MpvInstallMethod }
  | { readonly _tag: "Failed"; readonly jobId: string; readonly method: MpvInstallMethod; readonly issue: PlayerIssue };
export type InstallOutput = Readonly<{ jobId: string; sequence: number; stream: "stdout" | "stderr"; line: string }>;
export type PlayerSnapshot = Readonly<{
  stamp: Stamp;
  lifecycle: "running" | "closing" | "closed";
  playback: Playback;
  queue: { readonly revision: number; readonly keys: readonly string[]; readonly sync: "empty" | "applying" | "synced" | "unknown" };
  pending: { readonly commandId: string; readonly kind: string } | null;
  audio: { readonly volumePercent: number; readonly muted: boolean; readonly applied: boolean };
  binary: BinaryState;
  install: InstallState;
  installOutput: readonly InstallOutput[];
  issues: readonly PlayerIssue[];
}>;
export type CommandAck = Readonly<{ commandId: string; stamp: Stamp; jobId: string | null }>;
export type CommandResult =
  | { readonly ok: true; readonly ack: CommandAck; readonly snapshot: PlayerSnapshot }
  | { readonly ok: false; readonly commandId: string; readonly issue: PlayerIssue; readonly snapshot: PlayerSnapshot };
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
