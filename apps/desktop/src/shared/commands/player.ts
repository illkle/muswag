import { Schema, type Redacted } from "effect";
import type { PlaybackItem } from "@muswag/model";

/**
 * The main-process player as the rest of the app talks to it. Only what is decoded on arrival is a
 * schema: the commands a renderer may send, the result it gets back, and the parts of the state that
 * reach renderers in the tables of `state/player.ts`. What stays inside main is a plain type.
 */

const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

// ---- mpv discovery and installation ----

export const MpvInstallMethod = Schema.Literals(["brew", "winget", "scoop", "choco", "apt", "dnf", "pacman", "zypper"]);
export type MpvInstallMethod = typeof MpvInstallMethod.Type;
/** How the mpv binary in use was found. */
export const MpvSource = Schema.Literals(["env", "manual", "cache", "path", "well-known", "login-shell"]);
export type MpvSource = typeof MpvSource.Type;
export const MpvInstallOption = Schema.Struct({
  command: Schema.String,
  /** The app can open a terminal that runs `command`: the package manager is installed. */
  terminal: Schema.Boolean,
  method: MpvInstallMethod,
  note: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
});
export type MpvInstallOption = typeof MpvInstallOption.Type;

export const BinaryState = Schema.Union([
  Schema.TaggedStruct("Checking", {}),
  Schema.TaggedStruct("Ready", { path: Schema.String, version: Schema.String, source: MpvSource }),
  /**
   * `message` names the binary that was turned down and says why, or says that none was found.
   * `searched` is where the app looked besides PATH.
   */
  Schema.TaggedStruct("Unavailable", { message: Schema.String, options: Schema.Array(MpvInstallOption), searched: Schema.Array(Schema.String) }),
]);
export type BinaryState = typeof BinaryState.Type;

// ---- Commands ----

/** What a renderer may ask of the player. */
export const RendererCommand = Schema.Union([
  ...(["Play", "Pause", "RefreshBinary", "ClearBinaryPath", "DismissError"] as const).map((tag) => Schema.TaggedStruct(tag, {})),
  Schema.TaggedStruct("Seek", { seconds: Seconds }),
  Schema.TaggedStruct("SetVolume", { percent: Percent }),
  Schema.TaggedStruct("SetMuted", { muted: Schema.Boolean }),
  Schema.TaggedStruct("OpenInstallTerminal", { method: MpvInstallMethod }),
]);
export type RendererCommand = typeof RendererCommand.Type;

/** The occurrence to start, whether it should play, and where in it. */
export type Selection = { readonly key: string; readonly play: boolean; readonly positionSeconds: number };
/**
 * Every command the player runs. Those a renderer cannot send are main's own: the queue is changed
 * through the queue manager, and the path of a binary to run comes from the native dialog of
 * `player:locate`.
 */
export type PlayerCommand =
  | RendererCommand
  | { readonly _tag: "ApplyQueue"; readonly items: readonly PlaybackItem[]; readonly select: Selection | null }
  | { readonly _tag: "Restart" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "SetBinaryPath"; readonly path: string };

/** Server credentials as main keeps them: the token is redacted so it cannot reach logs by accident. */
export type PlayerCredentials = { readonly url: string; readonly username: string; readonly salt: string; readonly token: Redacted.Redacted<string> };

/**
 * How a command went, and the version the app state had once it was handled, which renderers wait for
 * to see its outcome. The message of a failure is also what the player's state says went wrong.
 */
export const CommandResult = Schema.Union([Schema.Struct({ ok: Schema.Literal(true), version: Count }), Schema.Struct({ ok: Schema.Literal(false), message: Schema.String, version: Count })]);
export type CommandResult = typeof CommandResult.Type;

// ---- State ----

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

/**
 * What went wrong last. It stays until a track loads, what it is about is put right, or the user
 * dismisses it. `fix` is what the user can do about it: play the track again, set mpv up, or log in.
 */
export const PlayerError = Schema.Struct({ message: Schema.String, fix: Schema.NullOr(Schema.Literals(["retry", "mpv", "login"])) });
export type PlayerError = typeof PlayerError.Type;

export type Media = { readonly item: PlaybackItem; readonly positionSeconds: number; readonly durationSeconds: number | null };
export type Playback =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly media: Media; readonly targetPaused: boolean }
  /** `buffering`: mpv should be playing but is waiting for data, e.g. after seeking far into a stream. */
  | { readonly _tag: "Playing"; readonly media: Media; readonly buffering: boolean }
  | { readonly _tag: "Paused"; readonly media: Media }
  | { readonly _tag: "Ended"; readonly media: Media }
  /** The track failed once and is being loaded again, in a new mpv. */
  | { readonly _tag: "Recovering"; readonly media: Media }
  /**
   * Playback broke off and mpv is gone; the state's `error` says what happened. `reason` is `track`
   * when this track could not be played, after a second attempt or because it never finished loading,
   * and `player` when mpv, its binary or the credentials were the problem.
   */
  | { readonly _tag: "Failed"; readonly media: Media; readonly reason: "track" | "player" }
  /** A failure whose error is gone: the track only waits to be played, from where it had got to. */
  | { readonly _tag: "Stopped"; readonly media: Media };

/** The player's state as main publishes it; renderers see the rows `state/player.ts` makes of it. */
export type PlayerSnapshot = {
  /** Orders snapshots: `epoch` is one run of the player, `revision` counts what it has published. */
  readonly stamp: { readonly epoch: string; readonly revision: number };
  readonly playback: Playback;
  readonly volumePercent: number;
  readonly muted: boolean;
  readonly binary: BinaryState;
  readonly error: PlayerError | null;
};

export const initialSnapshot = (epoch: string): PlayerSnapshot => ({
  stamp: { epoch, revision: 0 },
  playback: { _tag: "Idle" },
  volumePercent: 100,
  muted: false,
  binary: { _tag: "Checking" },
  error: null,
});
