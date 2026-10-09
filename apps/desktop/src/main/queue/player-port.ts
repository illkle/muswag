import type { PlaybackItem } from "@muswag/model";

import type { PlayerSnapshot } from "#shared/commands/player";
import { playerStatus, type PlayerStatus } from "#shared/state/player";

/** Every occurrence mpv should hold, in order, and optionally which one to play. */
export type ApplyQueueInput = {
  items: readonly PlaybackItem[];
  select?: {
    key: string;
    play: boolean;
    positionSeconds?: number;
  };
};

/** The player's state as the queue manager follows it. */
export type PlayerRuntimeState = {
  epoch?: string;
  sequence: number;
  /** The occurrence the player holds, whatever it is doing with it: loading it, playing it, or failed at it. */
  current: PlaybackItem | null;
  status: PlayerStatus;
  positionSeconds: number;
  paused: boolean;
  /**
   * Playback failed because `current` could not be played: the player tried it a second time, or it
   * never finished loading. Not set when mpv, its binary or the credentials are the problem.
   */
  trackFailed: boolean;
};

/** What the queue manager needs from the player. */
export interface QueuePlayerPort {
  /** With a selection, the player holds that occurrence from the moment it takes the command, also when it then fails to start it. */
  applyQueue(input: ApplyQueueInput): Promise<void>;
  restartCurrent(): Promise<void>;
  stop(): Promise<void>;
  /** The state as it is now, which is at least as late as any command that has settled. */
  getState(): Promise<PlayerRuntimeState>;
  subscribe(listener: (state: PlayerRuntimeState) => void): () => void;
}

export function runtimeView(snapshot: PlayerSnapshot): PlayerRuntimeState {
  const playback = snapshot.playback;
  const media = playback._tag === "Idle" ? null : playback.media;
  return {
    sequence: snapshot.stamp.revision,
    epoch: snapshot.stamp.epoch,
    current: media?.item ?? null,
    status: playerStatus(playback),
    positionSeconds: media?.positionSeconds ?? 0,
    paused: playback._tag === "Paused" || (playback._tag === "Loading" && playback.targetPaused),
    trackFailed: playback._tag === "Failed" && playback.reason === "track",
  };
}
