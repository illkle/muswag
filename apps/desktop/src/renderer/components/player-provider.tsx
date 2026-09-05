import { PlayerIPC } from "#/lib/ipc";
import { appReady } from "#/core/client";
import { DbQueueStorage } from "#/player/db-queue-storage";
import { getQueueCanGoNext, getQueueCanGoPrevious, QueueManager } from "#/player/queue-manager";
import { createQueueSourceFactory } from "#/player/source";
import { useStore } from "@tanstack/react-store";
import { initializePlayerConnection, PlayerConnectionStore } from "#/lib/ipc";
import { binaryView, installView, runtimeView } from "#/player/snapshot";

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

export function usePlayerCurrentTrackId() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.current?.track.id ?? null;
  });
}

export function usePlayerCurrentTrack() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.current?.track ?? null;
  });
}

export function usePlayerStatus() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.status;
  });
}

export function usePlayerError() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return !view.connected ? "Playback disconnected. Reconnecting…" : (view.issue?.message ?? state.error);
  });
}

export function usePlayerCanPlay() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return view.connected && !view.snapshot.pending && state.current !== null && state.status !== "loading";
  });
}

export function usePlayerCanGoForward() {
  const connected = usePlayerConnected();
  const queue = useQueueManagerState();
  return connected && getQueueCanGoNext(queue);
}

export function usePlayerCanGoBack() {
  const queue = useQueueManagerState();
  const runtime = useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state;
  });
  const connected = usePlayerConnected();
  return connected && getQueueCanGoPrevious(queue, runtime);
}

export function usePlayerCanSeek() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return view.connected && !view.snapshot.pending && ["playing", "paused"].includes(state.status) && (state.durationSeconds ?? 0) > 0;
  });
}

export function usePlayerDuration() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.durationSeconds;
  });
}

export function usePlayerPositionSeconds() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.positionSeconds;
  });
}

export function usePlayerMpvAvailable() {
  return useStore(PlayerConnectionStore, (view) => view.connected && view.snapshot.binary._tag === "Ready");
}

export function usePlayerMpvState() {
  return useStore(PlayerConnectionStore, (view) => binaryView(view.snapshot));
}

export function usePlayerMpvInstallState() {
  return useStore(PlayerConnectionStore, (view) => installView(view.snapshot));
}

export function usePlayerMuted() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.muted;
  });
}

export function usePlayerVolumePercent() {
  return useStore(PlayerConnectionStore, (view) => {
    const state = runtimeView(view.snapshot);
    return state.volumePercent;
  });
}

export function useQueueManagerState() {
  return useStore(queueManager.store, (state) => state);
}

export function usePlayerIssue() {
  return useStore(PlayerConnectionStore, (view) => view.issue ?? view.snapshot.issues.at(-1) ?? null);
}
export function usePlayerConnected() {
  return useStore(PlayerConnectionStore, (view) => view.connected);
}
