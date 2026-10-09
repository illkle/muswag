import type { Media, Playback, PlayerSnapshot } from "#shared/commands/player";
import type { SessionEvent } from "./mpv/session";

export const currentMedia = (state: PlayerSnapshot): Media | null => (state.playback._tag === "Idle" ? null : state.playback.media);
/** Playing or paused: the current track has loaded and mpv reports its position. */
export const isSettled = (playback: Playback): playback is Extract<Playback, { _tag: "Playing" | "Paused" }> => playback._tag === "Playing" || playback._tag === "Paused";
/** Paused, or loading in order to be: the track is not meant to be heard. */
export const isHeldPaused = (playback: Playback): boolean => playback._tag === "Paused" || (playback._tag === "Loading" && playback.targetPaused);
export const isCurrentEvent = (event: SessionEvent, generation: number | undefined, entryId: number | null): boolean =>
  event.generation === generation && event.entryId !== null && event.entryId === entryId;
export const isFiniteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const withMedia = (state: PlayerSnapshot, update: (media: Media) => Media): PlayerSnapshot => {
  const media = currentMedia(state);
  if (!media || state.playback._tag === "Idle") return state;
  return { ...state, playback: { ...state.playback, media: update(media) } };
};
export const withPosition = (state: PlayerSnapshot, positionSeconds: number): PlayerSnapshot =>
  withMedia(state, (media) => ({ ...media, positionSeconds: Math.max(0, Math.min(positionSeconds, media.durationSeconds ?? Infinity)) }));
export const withDuration = (state: PlayerSnapshot, durationSeconds: number): PlayerSnapshot => withMedia(state, (media) => ({ ...media, durationSeconds }));
/** `state` with nothing wrong. A failed track is then no failure to anyone: it only waits to be played. */
export const withoutError = (state: PlayerSnapshot): PlayerSnapshot => ({
  ...state,
  error: null,
  playback: state.playback._tag === "Failed" ? { _tag: "Stopped", media: state.playback.media } : state.playback,
});
