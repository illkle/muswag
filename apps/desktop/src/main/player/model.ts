import type { Media, Playback, PlayerIssue, PlayerSnapshot } from "#shared/player-contract";
import type { SessionEvent } from "./mpv/session";

const MAX_ISSUES = 20;

export const currentMedia = (state: PlayerSnapshot): Media | null => (state.playback._tag === "Idle" ? null : state.playback.media);
/** Playing or paused: the current track has loaded and mpv reports its position. */
export const isSettled = (playback: Playback): playback is Extract<Playback, { _tag: "Playing" | "Paused" }> => playback._tag === "Playing" || playback._tag === "Paused";
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
/** Appends an issue, replacing any earlier one matching `replaces`, and keeps the list bounded. */
export const withIssue = (issues: readonly PlayerIssue[], problem: PlayerIssue, replaces: (existing: PlayerIssue) => boolean): readonly PlayerIssue[] =>
  [...issues.filter((existing) => !replaces(existing)), problem].slice(-MAX_ISSUES);
