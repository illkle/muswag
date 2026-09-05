import type { Media, PlayerSnapshot } from "#shared/player-contract";
import type { SessionEvent } from "./mpv/session";
export const currentMedia = (state: PlayerSnapshot): Media | null => (state.playback._tag === "Idle" ? null : state.playback.media);
export const isCurrentEvent = (event: SessionEvent, generation: number | undefined, entryId: number | null): boolean =>
  event.generation === generation && event.entryId !== null && event.entryId === entryId;
export const withPosition = (state: PlayerSnapshot, positionSeconds: number): PlayerSnapshot => {
  const media = currentMedia(state);
  if (!media || state.playback._tag === "Idle") return state;
  return { ...state, playback: { ...state.playback, media: { ...media, positionSeconds: Math.max(0, Math.min(positionSeconds, media.durationSeconds ?? Infinity)) } } };
};
