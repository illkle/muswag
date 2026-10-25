import { Schema } from "effect";

import { BinaryState, PlaybackItemSchema, PlayerError, type Playback, type PlayerSnapshot } from "#shared/commands/player";

/**
 * The player's state as renderers see it, which main publishes whenever the player does (`app-state.ts`).
 * Position is a value of its own, so its updates twice a second do not touch anything else.
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
  error: Schema.NullOr(PlayerError),
});
export type PlayerRow = typeof PlayerRow.Type;

export const PlayerPositionRow = Schema.Struct({ id: PlayerId, positionSeconds: Seconds, durationSeconds: Schema.NullOr(Seconds) });
export type PlayerPositionRow = typeof PlayerPositionRow.Type;

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
    error: snapshot.error,
  };
}

export function playerPositionRow({ playback }: PlayerSnapshot): PlayerPositionRow {
  const media = playback._tag === "Idle" ? null : playback.media;
  return { id: PLAYER, positionSeconds: media?.positionSeconds ?? 0, durationSeconds: media?.durationSeconds ?? null };
}
