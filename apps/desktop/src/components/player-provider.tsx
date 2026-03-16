import { PlayerIPC } from "#/lib/db";
import {
  createDefaultPlayerMetaState,
  createDefaultPlayerNowPlayingState,
  createDefaultPlayerQueueState,
  getPlayerCanGoBack,
  getPlayerCanGoForward,
  getPlayerCanPlay,
  getPlayerCanSeek,
} from "#/shared/player";
import { createMirroredRendererStore } from "#/shared/store-sync";
import { useStore } from "@tanstack/react-store";

const PlayerMetaStore = createMirroredRendererStore({
  defaultState: createDefaultPlayerMetaState(),
  getEventState: (event) => (event.type === "meta" ? event.state : undefined),
  getSnapshot: PlayerIPC.getState,
  getSnapshotState: (snapshot) => snapshot.meta,
  subscribe: PlayerIPC.subscribe,
});

const PlayerQueueStore = createMirroredRendererStore({
  defaultState: createDefaultPlayerQueueState(),
  getEventState: (event) => (event.type === "queue" ? event.state : undefined),
  getSnapshot: PlayerIPC.getState,
  getSnapshotState: (snapshot) => snapshot.queue,
  subscribe: PlayerIPC.subscribe,
});

const PlayerNowPlayingStore = createMirroredRendererStore({
  defaultState: createDefaultPlayerNowPlayingState(),
  getEventState: (event) => (event.type === "nowPlaying" ? event.state : undefined),
  getSnapshot: PlayerIPC.getState,
  getSnapshotState: (snapshot) => snapshot.nowPlaying,
  subscribe: PlayerIPC.subscribe,
});

export function usePlayerCurrentIndex() {
  return useStore(PlayerQueueStore, (state) => state.currentIndex);
}

export function usePlayerQueue() {
  return useStore(PlayerQueueStore, (state) => state.queue);
}

export function usePlayerCurrentTrackId() {
  return useStore(PlayerQueueStore, (state) => state.currentTrackId);
}

export function usePlayerStatus() {
  return useStore(PlayerNowPlayingStore, (state) => state.status);
}

export function usePlayerCanPlay() {
  const queueState = useStore(PlayerQueueStore, (state) => state);
  const nowPlayingState = useStore(PlayerNowPlayingStore, (state) => state);
  return getPlayerCanPlay(queueState, nowPlayingState);
}

export function usePlayerCanGoForward() {
  const queueState = useStore(PlayerQueueStore, (state) => state);
  return getPlayerCanGoForward(queueState);
}

export function usePlayerCanGoBack() {
  const queueState = useStore(PlayerQueueStore, (state) => state);
  const nowPlayingState = useStore(PlayerNowPlayingStore, (state) => state);
  return getPlayerCanGoBack(queueState, nowPlayingState);
}

export function usePlayerCanSeek() {
  const queueState = useStore(PlayerQueueStore, (state) => state);
  const nowPlayingState = useStore(PlayerNowPlayingStore, (state) => state);
  return getPlayerCanSeek(queueState, nowPlayingState);
}

export function usePlayerDuration() {
  return useStore(PlayerNowPlayingStore, (state) => state.durationSeconds);
}

export function usePlayerPositionSeconds() {
  return useStore(PlayerNowPlayingStore, (state) => state.positionSeconds);
}

export function usePlayerMpvAvailable() {
  return useStore(PlayerMetaStore, (state) => state.mpvAvailable);
}
