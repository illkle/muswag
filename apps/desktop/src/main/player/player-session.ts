import { createStore } from "@tanstack/react-store";

import type { PlayQueueInput, PlayerQueueItem, PlayerState } from "../../shared/player";
import { createDefaultPlayerMetaState, createDefaultPlayerNowPlayingState, createDefaultPlayerQueueState } from "../../shared/player";

type MarkTrackLoadingOptions = {
  resumePlayback: boolean;
};

export const metaStore = createStore(createDefaultPlayerMetaState());
export const queueStore = createStore(createDefaultPlayerQueueState());
export const nowPlayingStore = createStore(createDefaultPlayerNowPlayingState());

let playbackQueue: PlayerQueueItem[] = [];
let pausedIntent = false;

export function getState(): PlayerState {
  return {
    meta: { ...metaStore.state },
    queue: {
      ...queueStore.state,
      queue: [...queueStore.state.queue],
    },
    nowPlaying: { ...nowPlayingStore.state },
  };
}

export function getCurrentQueueItem(): PlayerQueueItem | null {
  return playbackQueue[queueStore.state.currentIndex] ?? null;
}

export function hasCurrentTrack(): boolean {
  return queueStore.state.currentTrackId !== null;
}

export function getStatus(): PlayerState["nowPlaying"]["status"] {
  return nowPlayingStore.state.status;
}

export function shouldRestartOnPrevious(): boolean {
  return nowPlayingStore.state.positionSeconds > 5 || queueStore.state.currentIndex <= 0;
}

export function clampPosition(positionSeconds: number): number {
  return Math.max(0, Math.min(positionSeconds, nowPlayingStore.state.durationSeconds ?? positionSeconds));
}

export function clearQueue(): void {
  playbackQueue = [];
  pausedIntent = false;
  queueStore.setState(() => createDefaultPlayerQueueState());
  nowPlayingStore.setState(() => createDefaultPlayerNowPlayingState());
}

export function loadQueue(input: PlayQueueInput): void {
  if (input.queue.length === 0) {
    clearQueue();
    return;
  }

  playbackQueue = input.queue.map(cloneQueueItem);
  const currentIndex = clampIndex(input.startIndex, playbackQueue.length);
  pausedIntent = false;

  queueStore.setState(() => ({
    currentIndex,
    currentTrackId: playbackQueue[currentIndex]?.id ?? null,
    queue: playbackQueue.map((item) => item.id),
  }));
  nowPlayingStore.setState(() => ({
    durationSeconds: playbackQueue[currentIndex]?.duration ?? null,
    error: null,
    positionSeconds: 0,
    status: "loading",
  }));
}

export function markCurrentTrackLoading(options: MarkTrackLoadingOptions): void {
  if (!hasCurrentTrack()) {
    return;
  }

  pausedIntent = !options.resumePlayback;
  nowPlayingStore.setState((state) => ({
    ...state,
    durationSeconds: getCurrentQueueItem()?.duration ?? null,
    error: null,
    positionSeconds: 0,
    status: "loading",
  }));
}

export function advanceToNextTrack(options: MarkTrackLoadingOptions): boolean {
  if (!hasCurrentTrack() || queueStore.state.currentIndex >= queueStore.state.queue.length - 1) {
    return false;
  }

  const currentIndex = queueStore.state.currentIndex + 1;
  pausedIntent = !options.resumePlayback;

  queueStore.setState((state) => ({
    ...state,
    currentIndex,
    currentTrackId: playbackQueue[currentIndex]?.id ?? null,
  }));
  nowPlayingStore.setState((state) => ({
    ...state,
    durationSeconds: playbackQueue[currentIndex]?.duration ?? null,
    error: null,
    positionSeconds: 0,
    status: "loading",
  }));

  return true;
}

export function moveToPreviousTrack(options: MarkTrackLoadingOptions): boolean {
  if (!hasCurrentTrack() || queueStore.state.currentIndex <= 0) {
    return false;
  }

  const currentIndex = queueStore.state.currentIndex - 1;
  pausedIntent = !options.resumePlayback;

  queueStore.setState((state) => ({
    ...state,
    currentIndex,
    currentTrackId: playbackQueue[currentIndex]?.id ?? null,
  }));
  nowPlayingStore.setState((state) => ({
    ...state,
    durationSeconds: playbackQueue[currentIndex]?.duration ?? null,
    error: null,
    positionSeconds: 0,
    status: "loading",
  }));

  return true;
}

export function setPauseRequested(paused: boolean): void {
  pausedIntent = paused;
  nowPlayingStore.setState((state) => ({
    ...state,
    error: null,
    status: paused ? "paused" : "playing",
  }));
}

export function handlePauseChanged(paused: boolean): void {
  pausedIntent = paused;
  nowPlayingStore.setState((state) => ({
    ...state,
    status: state.status === "loading" || state.status === "ended" ? state.status : paused ? "paused" : "playing",
  }));
}

export function handleFileLoaded(): void {
  nowPlayingStore.setState((state) => ({
    ...state,
    error: null,
    status: pausedIntent ? "paused" : "playing",
  }));
}

export function handleSeekApplied(positionSeconds: number): void {
  nowPlayingStore.setState((state) => ({
    ...state,
    positionSeconds,
    status: state.status === "ended" ? (pausedIntent ? "paused" : "playing") : state.status,
  }));
}

export function handlePlaybackEnded(): void {
  nowPlayingStore.setState((state) => ({
    ...state,
    positionSeconds: state.durationSeconds ?? state.positionSeconds,
    status: "ended",
  }));
}

export function updatePosition(positionSeconds: number): void {
  nowPlayingStore.setState((state) => ({
    ...state,
    positionSeconds,
  }));
}

export function updateDuration(durationSeconds: number | null): void {
  nowPlayingStore.setState((state) => ({
    ...state,
    durationSeconds: durationSeconds ?? getCurrentQueueItem()?.duration ?? null,
  }));
}

export function markMpvAvailable(): void {
  if (metaStore.state.mpvAvailable) {
    return;
  }

  metaStore.setState(() => ({
    mpvAvailable: true,
  }));
}

export function applyError(message: string): void {
  metaStore.setState(() => ({
    mpvAvailable: !message.includes("mpv binary was not found"),
  }));
  nowPlayingStore.setState((state) => ({
    ...state,
    error: message,
    status: "error",
  }));
}

export function resetPlayerSession(): void {
  playbackQueue = [];
  pausedIntent = false;
  metaStore.setState(() => createDefaultPlayerMetaState());
  queueStore.setState(() => createDefaultPlayerQueueState());
  nowPlayingStore.setState(() => createDefaultPlayerNowPlayingState());
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length - 1);
}

function cloneQueueItem(item: PlayerQueueItem): PlayerQueueItem {
  return { ...item };
}
