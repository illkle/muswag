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
  current: PlaybackItem | null;
  status: PlayerStatus;
  positionSeconds: number;
  paused: boolean;
};

/** What the queue manager needs from the player. */
export interface QueuePlayerPort {
  applyQueue(input: ApplyQueueInput): Promise<void>;
  restartCurrent(): Promise<void>;
  stop(): Promise<void>;
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
  };
}
