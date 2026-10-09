import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

import { BinaryState, InstallOutput, InstallState, PlaybackItemSchema, PlayerError, type Playback, type PlayerSnapshot } from "#shared/commands/player";

/**
 * The player's state as renderers see it: memory tables in the state mirror (`mirror.ts`), which
 * main writes whenever the player publishes. Position has a table of its own, so its updates twice a second
 * do not touch anything else.
 */

const PLAYER = "player";
const PlayerId = Schema.Literal(PLAYER);
const Seconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * What the player is doing, as controls show it. Recovering counts as loading. `stopped` is a track
 * that failed and whose error is gone: Play loads it again.
 */
export const PlayerStatus = Schema.Literals(["idle", "loading", "playing", "paused", "ended", "stopped", "error"]);
export type PlayerStatus = typeof PlayerStatus.Type;
export const playerStatus = ({ _tag }: { readonly _tag: Playback["_tag"] }): PlayerStatus => (_tag === "Recovering" ? "loading" : _tag === "Failed" ? "error" : (_tag.toLowerCase() as PlayerStatus));

export const PlayerRow = Schema.Struct({
  id: PlayerId,
  status: PlayerStatus,
  /** The occurrence the status is about; `null` while idle. */
  item: Schema.NullOr(PlaybackItemSchema),
  /** Playing, but silent while mpv waits for data. */
  buffering: Schema.Boolean,
  volumePercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  muted: Schema.Boolean,
  binary: BinaryState,
  install: InstallState,
  error: Schema.NullOr(PlayerError),
});
export type PlayerRow = typeof PlayerRow.Type;
export const player = memoryTable("player", PlayerRow, { primaryKey: "id" });

export const PlayerPositionRow = Schema.Struct({ id: PlayerId, positionSeconds: Seconds, durationSeconds: Schema.NullOr(Seconds) });
export type PlayerPositionRow = typeof PlayerPositionRow.Type;
export const playerPosition = memoryTable("player_position", PlayerPositionRow, { primaryKey: "id" });

/** The tail of the running or last mpv installation's output. */
export const InstallOutputRow = Schema.Struct({ id: Schema.String, ...InstallOutput.fields });
export type InstallOutputRow = typeof InstallOutputRow.Type;
export const playerInstallOutput = memoryTable("player_install_output", InstallOutputRow, { primaryKey: "id" });

export const PLAYER_TABLES = [player, playerPosition, playerInstallOutput] as const;

// ---- From a player snapshot ----

export function playerRow(snapshot: PlayerSnapshot): PlayerRow {
  const { playback } = snapshot;
  return {
    id: PLAYER,
    status: playerStatus(playback),
    item: playback._tag === "Idle" ? null : playback.media.item,
    buffering: playback._tag === "Playing" && playback.buffering,
    volumePercent: snapshot.volumePercent,
    muted: snapshot.muted,
    binary: snapshot.binary,
    install: snapshot.install,
    error: snapshot.error,
  };
}

export function playerPositionRow({ playback }: PlayerSnapshot): PlayerPositionRow {
  const media = playback._tag === "Idle" ? null : playback.media;
  return { id: PLAYER, positionSeconds: media?.positionSeconds ?? 0, durationSeconds: media?.durationSeconds ?? null };
}

export const installOutputRows = (snapshot: PlayerSnapshot): InstallOutputRow[] => snapshot.installOutput.map((output) => ({ id: `${output.jobId}:${output.sequence}`, ...output }));
