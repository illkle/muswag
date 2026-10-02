import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

import { BinaryState, InstallOutput, InstallState, PlaybackItemSchema, PlayerIssue, type PlayerSnapshot } from "./player-contract";

/**
 * The player's state as renderers see it: memory tables in the state mirror (`state-mirror.ts`), which
 * main writes whenever the player publishes. Position has a table of its own, so its updates twice a second
 * do not touch anything else.
 */

const PLAYER = "player";
const PlayerId = Schema.Literal(PLAYER);
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** What the player is doing with which occurrence; `Playback` without the position. */
export const PlaybackState = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", { item: PlaybackItemSchema, targetPaused: Schema.Boolean }),
  Schema.TaggedStruct("Playing", { item: PlaybackItemSchema, buffering: Schema.Boolean }),
  Schema.TaggedStruct("Paused", { item: PlaybackItemSchema }),
  Schema.TaggedStruct("Ended", { item: PlaybackItemSchema }),
  Schema.TaggedStruct("Recovering", { item: PlaybackItemSchema }),
  Schema.TaggedStruct("Failed", { item: Schema.NullOr(PlaybackItemSchema), issue: PlayerIssue }),
]);
export type PlaybackState = typeof PlaybackState.Type;

/** What the player is doing, as controls show it: recovering counts as loading. */
export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";
export const playerStatus = ({ _tag }: { readonly _tag: PlaybackState["_tag"] }): PlayerStatus =>
  _tag === "Recovering" ? "loading" : _tag === "Failed" ? "error" : (_tag.toLowerCase() as PlayerStatus);

export const PlayerRow = Schema.Struct({
  id: PlayerId,
  playback: PlaybackState,
  /** The command main is working on; controls wait for it. */
  pending: Schema.NullOr(Schema.Struct({ commandId: Schema.String, kind: Schema.String })),
  volumePercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
  binary: BinaryState,
  install: InstallState,
});
export type PlayerRow = typeof PlayerRow.Type;
export const player = memoryTable("player", PlayerRow, { primaryKey: "id" });

export const PlayerPositionRow = Schema.Struct({ id: PlayerId, positionSeconds: Seconds, durationSeconds: Schema.NullOr(Seconds) });
export type PlayerPositionRow = typeof PlayerPositionRow.Type;
export const playerPosition = memoryTable("player_position", PlayerPositionRow, { primaryKey: "id" });

/** Issues in the order they were raised: the latest has the highest `order`. */
export const PlayerIssueRow = Schema.Struct({ ...PlayerIssue.fields, order: Schema.Int });
export type PlayerIssueRow = typeof PlayerIssueRow.Type;
export const playerIssues = memoryTable("player_issues", PlayerIssueRow, { primaryKey: "id" });

/** The tail of the running or last mpv installation's output. */
export const InstallOutputRow = Schema.Struct({ id: Schema.String, ...InstallOutput.fields });
export type InstallOutputRow = typeof InstallOutputRow.Type;
export const playerInstallOutput = memoryTable("player_install_output", InstallOutputRow, { primaryKey: "id" });

export const PLAYER_TABLES = [player, playerPosition, playerIssues, playerInstallOutput] as const;

// ---- From a player snapshot ----

export function playerRow(snapshot: PlayerSnapshot): PlayerRow {
  const { playback, audio } = snapshot;
  return { id: PLAYER, playback: playbackState(playback), pending: snapshot.pending, volumePercent: audio.volumePercent, muted: audio.muted, binary: snapshot.binary, install: snapshot.install };
}

function playbackState(playback: PlayerSnapshot["playback"]): PlaybackState {
  switch (playback._tag) {
    case "Idle":
      return playback;
    case "Loading":
      return { _tag: "Loading", item: playback.media.item, targetPaused: playback.targetPaused };
    case "Playing":
      return { _tag: "Playing", item: playback.media.item, buffering: playback.buffering };
    case "Paused":
    case "Ended":
    case "Recovering":
      return { _tag: playback._tag, item: playback.media.item };
    case "Failed":
      return { _tag: "Failed", item: playback.media?.item ?? null, issue: playback.issue };
  }
}

export function playerPositionRow({ playback }: PlayerSnapshot): PlayerPositionRow {
  const media = playback._tag === "Idle" ? null : playback.media;
  return { id: PLAYER, positionSeconds: media?.positionSeconds ?? 0, durationSeconds: media?.durationSeconds ?? null };
}

export const playerIssueRows = (snapshot: PlayerSnapshot): PlayerIssueRow[] => snapshot.issues.map((issue, order) => ({ ...issue, order }));

export const installOutputRows = (snapshot: PlayerSnapshot): InstallOutputRow[] => snapshot.installOutput.map((output) => ({ id: `${output.jobId}:${output.sequence}`, ...output }));
