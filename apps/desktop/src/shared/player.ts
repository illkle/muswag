import type { Song } from "@muswag/shared";

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export type PlayerQueueItem = Song;

export interface PlayQueueInput {
  queue: PlayerQueueItem[];
  startIndex: number;
}

export interface PlayerMetaState {
  mpvAvailable: boolean;
}

export interface PlayerQueueState {
  queue: string[];
  currentIndex: number;
  currentTrackId: string | null;
}

export interface PlayerNowPlayingState {
  status: PlayerStatus;
  positionSeconds: number;
  durationSeconds: number | null;
  error: string | null;
}

export interface PlayerVolumeState {
  volumePercent: number;
  muted: boolean;
}

export interface PlayerState {
  meta: PlayerMetaState;
  queue: PlayerQueueState;
  nowPlaying: PlayerNowPlayingState;
  volume: PlayerVolumeState;
}

export type PlayerEvent =
  | {
      type: "meta";
      state: PlayerMetaState;
    }
  | {
      type: "queue";
      state: PlayerQueueState;
    }
  | {
      type: "nowPlaying";
      state: PlayerNowPlayingState;
    }
  | {
      type: "volume";
      state: PlayerVolumeState;
    };

export function createDefaultPlayerMetaState(): PlayerMetaState {
  return {
    mpvAvailable: true,
  };
}

export function createDefaultPlayerQueueState(): PlayerQueueState {
  return {
    queue: [],
    currentIndex: -1,
    currentTrackId: null,
  };
}

export function createDefaultPlayerNowPlayingState(): PlayerNowPlayingState {
  return {
    status: "idle",
    positionSeconds: 0,
    durationSeconds: null,
    error: null,
  };
}

export function createDefaultPlayerVolumeState(): PlayerVolumeState {
  return {
    volumePercent: 100,
    muted: false,
  };
}

export function createDefaultPlayerState(): PlayerState {
  return {
    meta: createDefaultPlayerMetaState(),
    queue: createDefaultPlayerQueueState(),
    nowPlaying: createDefaultPlayerNowPlayingState(),
    volume: createDefaultPlayerVolumeState(),
  };
}

export function getPlayerCanPlay(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && nowPlayingState.status !== "loading";
}

export function getPlayerCanGoForward(queueState: PlayerQueueState): boolean {
  return queueState.currentTrackId !== null && queueState.currentIndex >= 0 && queueState.currentIndex < queueState.queue.length - 1;
}

export function getPlayerCanGoBack(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && (queueState.currentIndex > 0 || nowPlayingState.positionSeconds > 0);
}

export function getPlayerCanSeek(queueState: PlayerQueueState, nowPlayingState: PlayerNowPlayingState): boolean {
  return queueState.currentTrackId !== null && (nowPlayingState.durationSeconds ?? 0) > 0;
}
