import { PlayerIPC } from "#/lib/ipc";
import { dbPlayerReady } from "#/lib/db-renderer";
import { DbQueueStorage } from "#/player/db-queue-storage";
import { getQueueCanGoNext, getQueueCanGoPrevious, QueueManager } from "#/player/queue-manager";
import { createQueueSourceFactory } from "#/player/source";
import { createDefaultPlayerMetaState, createDefaultPlayerRuntimeState, getMpvAvailable, type PlayerRuntimeState } from "#shared/player";
import { createMirroredRendererStore } from "#shared/store-sync";
import { createStore, useStore } from "@tanstack/react-store";

const PlayerMetaStore = createMirroredRendererStore({
  defaultState: createDefaultPlayerMetaState(),
  getEventState: (event) => (event.type === "meta" ? event.state : undefined),
  getSnapshot: PlayerIPC.getState,
  getSnapshotState: (snapshot) => snapshot.meta,
  subscribe: PlayerIPC.subscribe,
});

const PlayerRuntimeStore = createStore({ ...createDefaultPlayerRuntimeState(), sequence: -1 });

function acceptRuntime(state: PlayerRuntimeState): void {
  if (state.sequence <= PlayerRuntimeStore.state.sequence) return;
  PlayerRuntimeStore.setState(() => structuredClone(state));
}

PlayerIPC.subscribeRuntime(acceptRuntime);
void PlayerIPC.getRuntimeState().then(acceptRuntime).catch(console.error);

export const queueManager = new QueueManager({
  player: {
    applyQueue: PlayerIPC.applyQueue,
    getState: PlayerIPC.getRuntimeState,
    restartCurrent: PlayerIPC.restartCurrent,
    stop: PlayerIPC.stop,
    subscribe: PlayerIPC.subscribeRuntime,
  },
  sources: createQueueSourceFactory(),
  storage: new DbQueueStorage(),
});

void dbPlayerReady.then(() => queueManager.restore()).catch((cause) => console.error("[queue] startup restoration failed", cause));

export function usePlayerCurrentTrackId() {
  return useStore(PlayerRuntimeStore, (state) => state.current?.track.id ?? null);
}

export function usePlayerCurrentTrack() {
  return useStore(PlayerRuntimeStore, (state) => state.current?.track ?? null);
}

export function usePlayerStatus() {
  return useStore(PlayerRuntimeStore, (state) => state.status);
}

export function usePlayerError() {
  return useStore(PlayerRuntimeStore, (state) => state.error);
}

export function usePlayerCanPlay() {
  return useStore(PlayerRuntimeStore, (state) => state.current !== null && state.status !== "loading");
}

export function usePlayerCanGoForward() {
  return getQueueCanGoNext(useQueueManagerState());
}

export function usePlayerCanGoBack() {
  const queue = useQueueManagerState();
  const runtime = useStore(PlayerRuntimeStore, (state) => state);
  return getQueueCanGoPrevious(queue, runtime);
}

export function usePlayerCanSeek() {
  return useStore(PlayerRuntimeStore, (state) => state.current !== null && (state.durationSeconds ?? 0) > 0);
}

export function usePlayerDuration() {
  return useStore(PlayerRuntimeStore, (state) => state.durationSeconds);
}

export function usePlayerPositionSeconds() {
  return useStore(PlayerRuntimeStore, (state) => state.positionSeconds);
}

export function usePlayerMpvAvailable() {
  return useStore(PlayerMetaStore, getMpvAvailable);
}

export function usePlayerMpvState() {
  return useStore(PlayerMetaStore, (state) => state.mpv);
}

export function usePlayerMpvInstallState() {
  return useStore(PlayerMetaStore, (state) => state.mpvInstall);
}

export function usePlayerMuted() {
  return useStore(PlayerRuntimeStore, (state) => state.muted);
}

export function usePlayerVolumePercent() {
  return useStore(PlayerRuntimeStore, (state) => state.volumePercent);
}

export function useQueueManagerState() {
  return useStore(queueManager.store, (state) => state);
}
