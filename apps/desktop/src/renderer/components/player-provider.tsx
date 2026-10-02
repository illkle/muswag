import { appCommand, appStates } from "#/lib/app-ipc";
import { initializePlayerConnection, PlayerConnectionStore } from "#/player/connection";
import type { PlayerRuntimeState } from "#shared/player";
import { binaryView, installView, runtimeView } from "#shared/player-snapshot";
import { getQueueCanGoNext, getQueueCanGoPrevious } from "#shared/queue-state";
import type { QueueSourceRef, Song } from "@muswag/model";
import { useStore } from "@tanstack/react-store";

initializePlayerConnection();

/** The playback queue lives in main; these send it commands. */
export const queueManager = {
  playSource: (ref: QueueSourceRef, key: string) => appCommand("queue:playSource", ref, key),
  enqueue: (tracks: readonly Pick<Song, "id">[]) =>
    appCommand(
      "queue:enqueue",
      tracks.map(({ id }) => id),
    ),
  removeQueued: (key: string) => appCommand("queue:removeQueued", key),
  clearQueued: () => appCommand("queue:clearQueued"),
  next: () => appCommand("queue:next"),
  previous: () => appCommand("queue:previous"),
};

type ConnectionView = typeof PlayerConnectionStore.state;
const usePlayerRuntime = <A,>(select: (runtime: PlayerRuntimeState, view: ConnectionView) => A) => useStore(PlayerConnectionStore, (view) => select(runtimeView(view.snapshot), view));

export const usePlayerConnected = () => useStore(PlayerConnectionStore, (view) => view.connected);
export const usePlayerCurrentTrackId = () => usePlayerRuntime((runtime) => runtime.current?.track.id ?? null);
export const usePlayerCurrentTrack = () => usePlayerRuntime((runtime) => runtime.current?.track ?? null);
export const usePlayerStatus = () => usePlayerRuntime((runtime) => runtime.status);
export const usePlayerBuffering = () => usePlayerRuntime((runtime) => runtime.buffering);
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
export const useQueueManagerState = () => useStore(appStates.queue, (state) => state);
