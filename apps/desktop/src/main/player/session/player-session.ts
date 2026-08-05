import { createStore } from "@tanstack/react-store";

import type { PlayQueueInput, PlayerQueueContext, PlayerQueueItem, PlayerState, PlayerStatus, PlayerVolumeState } from "../../../shared/player";
import { createDefaultPlayerNowPlayingState, createDefaultPlayerQueueState, createDefaultPlayerVolumeState } from "../../../shared/player";

export type TrackSelection = { track: PlayerQueueItem; resume: boolean };

export class PlayerSession {
  readonly queueStore = createStore(createDefaultPlayerQueueState());
  readonly nowPlayingStore = createStore(createDefaultPlayerNowPlayingState());
  readonly volumeStore = createStore(createDefaultPlayerVolumeState());

  private playbackQueue: PlayerQueueItem[] = [];
  private pausedIntent = false;

  getState(): Pick<PlayerState, "queue" | "nowPlaying" | "volume"> {
    return {
      queue: {
        ...this.queueStore.state,
        context: cloneContext(this.queueStore.state.context),
        queue: [...this.queueStore.state.queue],
      },
      nowPlaying: { ...this.nowPlayingStore.state },
      volume: { ...this.volumeStore.state },
    };
  }

  get status(): PlayerStatus {
    return this.nowPlayingStore.state.status;
  }

  get currentTrack(): PlayerQueueItem | null {
    return this.playbackQueue[this.queueStore.state.currentIndex] ?? null;
  }

  loadQueue(input: PlayQueueInput): TrackSelection | null {
    if (input.queue.length === 0) {
      this.clear();
      return null;
    }

    this.playbackQueue = input.queue.map((track) => ({ ...track }));
    const requestedIndex = Number.isFinite(input.startIndex) ? Math.trunc(input.startIndex) : 0;
    const currentIndex = Math.min(Math.max(requestedIndex, 0), this.playbackQueue.length - 1);
    this.pausedIntent = false;
    this.queueStore.setState(() => ({
      context: cloneContext(input.context ?? null),
      currentIndex,
      currentTrackId: this.playbackQueue[currentIndex]?.id ?? null,
      queue: this.playbackQueue.map((track) => track.id),
    }));
    return this.selectCurrent(true);
  }

  clear(): void {
    this.playbackQueue = [];
    this.pausedIntent = false;
    this.queueStore.setState(() => createDefaultPlayerQueueState());
    this.nowPlayingStore.setState(() => createDefaultPlayerNowPlayingState());
  }

  next(options: { resume: boolean }): TrackSelection | null {
    const currentIndex = this.queueStore.state.currentIndex;
    if (!this.currentTrack || currentIndex >= this.playbackQueue.length - 1) return null;
    this.queueStore.setState((state) => ({
      ...state,
      currentIndex: currentIndex + 1,
      currentTrackId: this.playbackQueue[currentIndex + 1]?.id ?? null,
    }));
    return this.selectCurrent(options.resume);
  }

  previous(options: { resume: boolean }): TrackSelection | "restart" | null {
    if (!this.currentTrack) return null;
    if (this.nowPlayingStore.state.positionSeconds > 5 || this.queueStore.state.currentIndex === 0) return "restart";

    const currentIndex = this.queueStore.state.currentIndex - 1;
    if (currentIndex < 0) return null;
    this.queueStore.setState((state) => ({
      ...state,
      currentIndex,
      currentTrackId: this.playbackQueue[currentIndex]?.id ?? null,
    }));
    return this.selectCurrent(options.resume);
  }

  reloadCurrent(options: { resume: boolean }): TrackSelection | null {
    return this.currentTrack ? this.selectCurrent(options.resume) : null;
  }

  pauseRequested(paused: boolean): void {
    this.pausedIntent = paused;
    this.nowPlayingStore.setState((state) => ({
      ...state,
      error: null,
      status: state.status === "loading" || state.status === "ended" ? state.status : paused ? "paused" : "playing",
    }));
  }

  seekApplied(positionSeconds: number): void {
    const boundedPosition = this.clampPosition(positionSeconds);
    this.nowPlayingStore.setState((state) => ({
      ...state,
      positionSeconds: boundedPosition,
      status: state.status === "ended" ? (this.pausedIntent ? "paused" : "playing") : state.status,
    }));
  }

  volumeRequested(volumePercent: number): void {
    this.volumeStore.setState((state) => ({ ...state, volumePercent: this.clampVolume(volumePercent) }));
  }

  mutedRequested(muted: boolean): void {
    this.volumeStore.setState((state) => ({ ...state, muted }));
  }

  pauseChanged(paused: boolean): void {
    if (this.nowPlayingStore.state.status === "loading" || this.nowPlayingStore.state.status === "ended") return;
    this.pausedIntent = paused;
    this.nowPlayingStore.setState((state) => ({
      ...state,
      status: paused ? "paused" : "playing",
    }));
  }

  fileLoaded(): void {
    this.nowPlayingStore.setState((state) => (state.status !== "loading" ? state : { ...state, error: null, status: this.pausedIntent ? "paused" : "playing" }));
  }

  playbackEnded(): void {
    this.nowPlayingStore.setState((state) => ({
      ...state,
      positionSeconds: state.durationSeconds ?? state.positionSeconds,
      status: "ended",
    }));
  }

  positionChanged(positionSeconds: number): void {
    this.nowPlayingStore.setState((state) => ({ ...state, positionSeconds }));
  }

  durationChanged(durationSeconds: number | null): void {
    this.nowPlayingStore.setState((state) => ({
      ...state,
      durationSeconds: durationSeconds ?? this.currentTrack?.duration ?? null,
    }));
  }

  volumeChanged(volumePercent: number): void {
    this.volumeRequested(volumePercent);
  }

  mutedChanged(muted: boolean): void {
    this.mutedRequested(muted);
  }

  fail(message: string): void {
    this.nowPlayingStore.setState((state) => ({ ...state, error: message, status: "error" }));
  }

  clampPosition(positionSeconds: number): number {
    const value = Number.isFinite(positionSeconds) ? positionSeconds : 0;
    return Math.max(0, Math.min(value, this.nowPlayingStore.state.durationSeconds ?? value));
  }

  clampVolume(volumePercent: number): number {
    if (!Number.isFinite(volumePercent)) return this.volumeStore.state.volumePercent;
    return Math.min(100, Math.max(0, Math.round(volumePercent)));
  }

  restoreVolume(state: PlayerVolumeState): void {
    this.volumeStore.setState(() => ({ muted: state.muted, volumePercent: this.clampVolume(state.volumePercent) }));
  }

  reset(): void {
    this.playbackQueue = [];
    this.pausedIntent = false;
    this.queueStore.setState(() => createDefaultPlayerQueueState());
    this.nowPlayingStore.setState(() => createDefaultPlayerNowPlayingState());
    this.volumeStore.setState(() => createDefaultPlayerVolumeState());
  }

  private selectCurrent(resume: boolean): TrackSelection | null {
    const track = this.currentTrack;
    if (!track) return null;
    this.pausedIntent = !resume;
    this.nowPlayingStore.setState(() => ({
      durationSeconds: track.duration ?? null,
      error: null,
      positionSeconds: 0,
      status: "loading",
    }));
    return { resume, track: { ...track } };
  }
}

function cloneContext(context: PlayerQueueContext): PlayerQueueContext {
  if (context?.type === "playlist") return { ...context, entryIds: [...context.entryIds] };
  return context ? { ...context } : null;
}
