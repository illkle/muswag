import type { PlayQueueInput, PlayerEvent, PlayerNowPlayingState, PlayerQueueState, PlayerState } from "../../shared/player";
import { bridgeMainStoreToEvent } from "../../shared/store-sync";
import {
  disposeMpvIpcClient,
  getDefaultMpvIpcPath,
  initializeMpvIpcClient,
  loadFile as loadMpvFile,
  seekAbsolute,
  setPause as setMpvPause,
  stop as stopMpvPlayback,
  subscribe as subscribeToMpvIpcClient,
  type MpvClientEvent,
} from "./mpv-ipc-client";
import { createMpvStreamSource } from "./mpv-stream-source";
import {
  advanceToNextTrack,
  applyError as applySessionError,
  clampPosition,
  clearQueue,
  getCurrentQueueItem,
  getStatus,
  handleFileLoaded,
  handlePauseChanged,
  handlePlaybackEnded,
  handleSeekApplied,
  hasCurrentTrack,
  loadQueue,
  markCurrentTrackLoading,
  markMpvAvailable,
  metaStore,
  moveToPreviousTrack,
  nowPlayingStore,
  queueStore,
  resetPlayerSession,
  setPauseRequested,
  shouldRestartOnPrevious,
  updateDuration,
  updatePosition,
} from "./player-session";

const POSITION_BROADCAST_INTERVAL_MS = 500;

export { getDefaultMpvIpcPath };

const playerEventListeners = new Set<(event: PlayerEvent) => void>();

let operationChain: Promise<void> = Promise.resolve();
let streamSource: ReturnType<typeof createMpvStreamSource> | undefined;
let clientSubscription: (() => void) | undefined;
let metaBridgeDispose: (() => void) | undefined;
let queueBridgeDispose: (() => void) | undefined;
let nowPlayingBridgeDispose: (() => void) | undefined;

export function initializePlayer(options: { ipcPath: string; mpvBinaryPath: string }): void {
  if (streamSource) {
    return;
  }

  console.debug("[player][mpv][main]", "controller:init", {
    ipcPath: options.ipcPath,
    mpvBinaryPath: options.mpvBinaryPath,
  });

  streamSource = createMpvStreamSource(options.getDb);
  initializeMpvIpcClient({
    ipcPath: options.ipcPath,
    mpvBinaryPath: options.mpvBinaryPath,
  });
  clientSubscription = subscribeToMpvIpcClient((event) => {
    handleClientEvent(event);
  });
  subscribeToStores();
}

export function disposePlayer(): void {
  console.debug("[player][mpv][main]", "controller:dispose");

  metaBridgeDispose?.();
  metaBridgeDispose = undefined;
  queueBridgeDispose?.();
  queueBridgeDispose = undefined;
  nowPlayingBridgeDispose?.();
  nowPlayingBridgeDispose = undefined;
  clientSubscription?.();
  clientSubscription = undefined;
  disposeMpvIpcClient();
  streamSource = undefined;
  resetPlayerSession();
}

export function subscribe(listener: (event: PlayerEvent) => void): () => void {
  playerEventListeners.add(listener);

  return () => {
    playerEventListeners.delete(listener);
  };
}

export async function playQueue(input: PlayQueueInput): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:playQueue", {
      queueLength: input.queue.length,
      startIndex: input.startIndex,
      startTrackId: input.queue[input.startIndex]?.id ?? null,
    });

    if (input.queue.length === 0) {
      await stopPlayback();
      clearQueue();
      return;
    }

    loadQueue(input);
    await playCurrentTrack({ resumePlayback: true });
  });
}

export async function play(): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:play");
    if (!hasCurrentTrack()) {
      return;
    }

    if (getStatus() === "ended") {
      markCurrentTrackLoading({ resumePlayback: true });
      await playCurrentTrack({ resumePlayback: true });
      return;
    }

    await setPause(false);
  });
}

export async function pause(): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:pause");
    if (!hasCurrentTrack()) {
      return;
    }

    await setPause(true);
  });
}

export async function toggle(): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:toggle");
    if (!hasCurrentTrack()) {
      return;
    }

    if (getStatus() === "ended") {
      markCurrentTrackLoading({ resumePlayback: true });
      await playCurrentTrack({ resumePlayback: true });
      return;
    }

    await setPause(!(getStatus() === "paused"));
  });
}

export async function seek(positionSeconds: number): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:seek", { positionSeconds });
    if (!hasCurrentTrack()) {
      return;
    }

    await performSeek(positionSeconds);
  });
}

export async function next(): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:next");
    if (!hasCurrentTrack()) {
      return;
    }

    const resumePlayback = getStatus() !== "paused";
    if (!advanceToNextTrack({ resumePlayback })) {
      return;
    }

    await playCurrentTrack({ resumePlayback });
  });
}

export async function previous(): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:previous");
    if (!hasCurrentTrack()) {
      return;
    }

    if (shouldRestartOnPrevious()) {
      await performSeek(0);
      return;
    }

    const resumePlayback = getStatus() !== "paused";
    if (!moveToPreviousTrack({ resumePlayback })) {
      await performSeek(0);
      return;
    }

    await playCurrentTrack({ resumePlayback });
  });
}

function subscribeToStores(): void {
  if (metaBridgeDispose || queueBridgeDispose || nowPlayingBridgeDispose) {
    return;
  }

  metaBridgeDispose = bridgeMainStoreToEvent({
    createEvent: (state) => ({ state, type: "meta" as const }),
    emitEvent: emitState,
    isEqual: isSameMetaState,
    store: metaStore,
  });
  queueBridgeDispose = bridgeMainStoreToEvent({
    createEvent: (state) => ({ state, type: "queue" as const }),
    emitEvent: emitState,
    isEqual: isSameQueueState,
    store: queueStore,
  });
  nowPlayingBridgeDispose = bridgeMainStoreToEvent({
    createEvent: (state) => ({ state, type: "nowPlaying" as const }),
    emitEvent: emitState,
    isEqual: isSameNowPlayingState,
    shouldThrottle: isPositionOnlyNowPlayingChange,
    store: nowPlayingStore,
    throttleMs: POSITION_BROADCAST_INTERVAL_MS,
  });
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = operationChain.then(operation, operation);
  operationChain = nextOperation.then(
    () => undefined,
    () => undefined,
  );
  return nextOperation;
}

function handleClientEvent(event: MpvClientEvent): void {
  switch (event.type) {
    case "pause-change":
      handlePauseChanged(event.paused);
      return;
    case "time-pos-change":
      updatePosition(event.positionSeconds);
      return;
    case "duration-change":
      updateDuration(event.durationSeconds);
      return;
    case "file-loaded":
      handleFileLoaded();
      return;
    case "end-file":
      if (event.reason !== "eof") {
        return;
      }

      void enqueue(async () => {
        if (advanceToNextTrack({ resumePlayback: true })) {
          await playCurrentTrack({ resumePlayback: true });
          return;
        }

        handlePlaybackEnded();
      });
      return;
    case "unexpected-exit":
      applyError(new Error("mpv exited unexpectedly."));
      return;
    case "error":
      applyError(event.cause);
      return;
  }
}

async function playCurrentTrack(options: { resumePlayback: boolean }): Promise<void> {
  ensureInitialized();

  const currentTrack = getCurrentQueueItem();
  if (!currentTrack) {
    return;
  }

  try {
    const nextStreamSource = streamSource;
    if (!nextStreamSource) {
      throw new Error("Player module has not been initialized.");
    }

    const streamUrl = await nextStreamSource.getStreamUrl(currentTrack.id);
    console.debug("[player][mpv][main]", "track:load", {
      streamUrl,
      title: currentTrack.title,
      trackId: currentTrack.id,
    });

    if (options.resumePlayback) {
      await setMpvPause(false);
    }
    await loadMpvFile(streamUrl);
    markMpvAvailable();
  } catch (cause) {
    applyError(cause);
  }
}

async function setPause(paused: boolean): Promise<void> {
  ensureInitialized();

  try {
    console.debug("[player][mpv][main]", "track:setPause", { paused });
    await setMpvPause(paused);
    markMpvAvailable();
    setPauseRequested(paused);
  } catch (cause) {
    applyError(cause);
  }
}

async function performSeek(positionSeconds: number): Promise<void> {
  ensureInitialized();

  const boundedPosition = clampPosition(positionSeconds);

  try {
    console.debug("[player][mpv][main]", "track:seek", { boundedPosition });
    await seekAbsolute(boundedPosition);
    markMpvAvailable();
    handleSeekApplied(boundedPosition);
  } catch (cause) {
    applyError(cause);
  }
}

async function stopPlayback(): Promise<void> {
  if (!streamSource) {
    return;
  }

  try {
    console.debug("[player][mpv][main]", "track:stop");
    await stopMpvPlayback();
  } catch {
    return;
  }
}

function emitState(event: PlayerEvent): void {
  console.debug("[player][mpv][main]", "broadcast:state", { type: event.type });

  for (const listener of playerEventListeners) {
    listener(event);
  }
}

function applyError(cause: unknown): void {
  console.error("[player][mpv][main]", "state:error", cause);
  applySessionError(cause instanceof Error ? cause.message : "Playback failed");
}

function ensureInitialized(): void {
  if (!streamSource) {
    throw new Error("Player module has not been initialized.");
  }
}

function isSameMetaState(nextState: PlayerState["meta"], previousState: PlayerState["meta"]): boolean {
  return nextState.mpvAvailable === previousState.mpvAvailable;
}

function isSameQueueState(nextState: PlayerQueueState, previousState: PlayerQueueState): boolean {
  return (
    nextState.currentIndex === previousState.currentIndex &&
    nextState.currentTrackId === previousState.currentTrackId &&
    nextState.queue.length === previousState.queue.length &&
    nextState.queue.every((trackId, index) => trackId === previousState.queue[index])
  );
}

function isSameNowPlayingState(nextState: PlayerNowPlayingState, previousState: PlayerNowPlayingState): boolean {
  return (
    nextState.durationSeconds === previousState.durationSeconds &&
    nextState.error === previousState.error &&
    nextState.positionSeconds === previousState.positionSeconds &&
    nextState.status === previousState.status
  );
}

function isPositionOnlyNowPlayingChange(nextState: PlayerNowPlayingState, previousState: PlayerNowPlayingState): boolean {
  return (
    nextState.positionSeconds !== previousState.positionSeconds &&
    nextState.durationSeconds === previousState.durationSeconds &&
    nextState.error === previousState.error &&
    nextState.status === previousState.status
  );
}
