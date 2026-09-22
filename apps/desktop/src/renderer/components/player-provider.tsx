import { appReady } from "#/core/client";
import { initializePlayerConnection, PlayerConnectionStore, PlayerIPC } from "#/player/connection";
import { DbQueueStorage } from "#/player/db-queue-storage";
import { getQueueCanGoNext, getQueueCanGoPrevious, QueueManager } from "#/player/queue-manager";
import { binaryView, installView, runtimeView } from "#/player/snapshot";
import { createQueueSourceFactory } from "#/player/source";
import type { PlayerRuntimeState } from "#shared/player";
import { useStore } from "@tanstack/react-store";

initializePlayerConnection();

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

void appReady.then(() => queueManager.restore()).catch((cause) => console.error("[queue] startup restoration failed", cause));

type ConnectionView = typeof PlayerConnectionStore.state;
const usePlayerRuntime = <A,>(select: (runtime: PlayerRuntimeState, view: ConnectionView) => A) => useStore(PlayerConnectionStore, (view) => select(runtimeView(view.snapshot), view));

export const usePlayerConnected = () => useStore(PlayerConnectionStore, (view) => view.connected);
export const usePlayerCurrentTrackId = () => usePlayerRuntime((runtime) => runtime.current?.track.id ?? null);
export const usePlayerCurrentTrack = () => usePlayerRuntime((runtime) => runtime.current?.track ?? null);
export const usePlayerStatus = () => usePlayerRuntime((runtime) => runtime.status);
export const usePlayerDuration = () => usePlayerRuntime((runtime) => runtime.durationSeconds);
export const usePlayerPositionSeconds = () => usePlayerRuntime((runtime) => runtime.positionSeconds);
export const usePlayerMuted = () => usePlayerRuntime((runtime) => runtime.muted);
export const usePlayerVolumePercent = () => usePlayerRuntime((runtime) => runtime.volumePercent);
export const usePlayerError = () => usePlayerRuntime((runtime, view) => (!view.connected ? "Playback disconnected. Reconnecting…" : (view.issue?.message ?? runtime.error)));
export const usePlayerIssue = () => useStore(PlayerConnectionStore, (view) => view.issue ?? view.snapshot.issues.at(-1) ?? null);

/** Controls are disabled while disconnected or while main is still processing a command. */
const isIdleConnection = (view: ConnectionView) => view.connected && !view.snapshot.pending;
export const usePlayerCanPlay = () => usePlayerRuntime((runtime, view) => isIdleConnection(view) && runtime.current !== null && runtime.status !== "loading");
export const usePlayerCanSeek = () =>
  usePlayerRuntime((runtime, view) => isIdleConnection(view) && (runtime.status === "playing" || runtime.status === "paused") && (runtime.durationSeconds ?? 0) > 0);

export function usePlayerCanGoForward() {
  const connected = usePlayerConnected();
  const queue = useQueueManagerState();
  return connected && getQueueCanGoNext(queue);
}
export function usePlayerCanGoBack() {
  const queue = useQueueManagerState();
  const runtime = usePlayerRuntime((runtime) => runtime);
  const connected = usePlayerConnected();
  return connected && getQueueCanGoPrevious(queue, runtime);
}

export const usePlayerMpvAvailable = () => useStore(PlayerConnectionStore, (view) => view.connected && view.snapshot.binary._tag === "Ready");
export const usePlayerMpvState = () => useStore(PlayerConnectionStore, (view) => binaryView(view.snapshot));
export const usePlayerMpvInstallState = () => useStore(PlayerConnectionStore, (view) => installView(view.snapshot));
export const useQueueManagerState = () => useStore(queueManager.store, (state) => state);
