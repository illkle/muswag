import { isAbsolute } from "node:path";

import type {
  MpvInstallMethod,
  MpvState,
  PlayQueueInput,
  PlayerEvent,
  PlayerNowPlayingState,
  PlayerQueueState,
  PlayerState,
} from "../../shared/player";
import { getMpvUnavailableReason, isSamePlayerMetaState } from "../../shared/player";
import type { UserCredentialsToLogin } from "@muswag/shared";
import { bridgeMainStoreToEvent } from "../../shared/store-sync";
import { isMpvResolutionError, MpvUnavailableError } from "./mpv-errors";
import { cancelMpvInstall as cancelRunningInstall, runMpvInstall, type MpvInstallOutput } from "./mpv-installer";
import { detectInstallCandidates, resolveMpvBinary } from "./mpv-locator";
import { createDefaultMpvPathState, loadMpvPathState, saveMpvPathState, type MpvPathState } from "./mpv-path-persistence";
import {
  disposeMpvIpcClient,
  getDefaultMpvIpcPath,
  initializeMpvIpcClient,
  loadFile as loadMpvFile,
  seekAbsolute,
  setMuted as setMpvMuted,
  setPause as setMpvPause,
  setVolume as setMpvVolume,
  stop as stopMpvPlayback,
  subscribe as subscribeToMpvIpcClient,
  type MpvClientEvent,
} from "./mpv-ipc-client";
import { createMpvStreamSource } from "./mpv-stream-source";
import {
  advanceToNextTrack,
  applyError as applySessionError,
  applyMpvInstallState,
  applyMpvState,
  clampPosition,
  clampVolumePercent,
  clearQueue,
  getCurrentQueueItem,
  getMpvState,
  getStatus,
  handleFileLoaded,
  handleMutedChanged,
  handlePauseChanged,
  handlePlaybackEnded,
  handleSeekApplied,
  handleVolumeChanged,
  hasCurrentTrack,
  loadQueue,
  markCurrentTrackLoading,
  metaStore,
  moveToPreviousTrack,
  nowPlayingStore,
  queueStore,
  resetPlayerSession,
  restoreVolumeState,
  setMutedRequested,
  setPauseRequested,
  setVolumeRequested,
  shouldRestartOnPrevious,
  updateDuration,
  updatePosition,
  volumeStore,
} from "./player-session";
import { loadPlayerVolumeState, savePlayerVolumeState } from "./player-volume-persistence";

const POSITION_BROADCAST_INTERVAL_MS = 500;

export { getDefaultMpvIpcPath };

const playerEventListeners = new Set<(event: PlayerEvent) => void>();

let operationChain: Promise<void> = Promise.resolve();
let streamSource: ReturnType<typeof createMpvStreamSource> | undefined;
let clientSubscription: (() => void) | undefined;
let metaBridgeDispose: (() => void) | undefined;
let queueBridgeDispose: (() => void) | undefined;
let nowPlayingBridgeDispose: (() => void) | undefined;
let volumeBridgeDispose: (() => void) | undefined;
let volumePersistenceDispose: (() => void) | undefined;
let credentials: UserCredentialsToLogin | null = null;
let mpvPathStatePath: string | undefined;
let mpvPathState: MpvPathState = createDefaultMpvPathState();
let resolvedMpvBinaryPath: string | null = null;
let pendingMpvResolution: Promise<MpvState> | undefined;

export function initializePlayer(options: { ipcPath: string; mpvPathStatePath: string; volumeStatePath: string }): void {
  if (streamSource) {
    return;
  }

  console.debug("[player][mpv][main]", "controller:init", {
    ipcPath: options.ipcPath,
    mpvPathStatePath: options.mpvPathStatePath,
  });

  streamSource = createMpvStreamSource(() => credentials);
  mpvPathStatePath = options.mpvPathStatePath;
  mpvPathState = loadMpvPathState(options.mpvPathStatePath);
  restoreVolumeState(loadPlayerVolumeState(options.volumeStatePath));
  volumePersistenceDispose = subscribeToVolumePersistence(options.volumeStatePath);
  initializeMpvIpcClient({
    getMpvBinaryPath: () => resolvedMpvBinaryPath,
    ipcPath: options.ipcPath,
  });
  clientSubscription = subscribeToMpvIpcClient((event) => {
    handleClientEvent(event);
  });
  subscribeToStores();

  // Resolve up front so a missing binary is reported at startup instead of on first play.
  void refreshMpvAvailability();
}

/** Looks for a usable mpv binary and publishes the result to the renderer. */
export function refreshMpvAvailability(): Promise<MpvState> {
  if (pendingMpvResolution) {
    return pendingMpvResolution;
  }

  applyMpvState({ status: "checking" });

  pendingMpvResolution = resolveMpvBinary({
    cachedPath: mpvPathState.cachedPath,
    manualPath: mpvPathState.manualPath,
  })
    .catch((cause): MpvState => {
      console.error("[player][mpv][main]", "mpv:resolve:error", cause);
      return { checkedPaths: [], installOptions: [], status: "missing" };
    })
    .then((state) => {
      applyResolvedMpvState(state);
      return state;
    })
    .finally(() => {
      pendingMpvResolution = undefined;
    });

  return pendingMpvResolution;
}

/** Points the player at a binary the user picked by hand. */
export async function setManualMpvPath(binaryPath: string): Promise<MpvState> {
  updateMpvPathState({ cachedPath: null, manualPath: binaryPath });
  return refreshMpvAvailability();
}

/** Drops a hand-picked binary and goes back to automatic discovery. */
export async function clearManualMpvPath(): Promise<MpvState> {
  updateMpvPathState({ cachedPath: null, manualPath: null });
  return refreshMpvAvailability();
}

/** Runs a package manager install for mpv, then re-resolves. */
export async function installMpv(method: MpvInstallMethod, onOutput: (output: MpvInstallOutput) => void): Promise<MpvState> {
  const candidate = (await detectInstallCandidates()).find((installCandidate) => installCandidate.option.method === method);

  if (!candidate) {
    applyMpvInstallState({
      command: method,
      error: `${method} is not available on this machine.`,
      method,
      status: "failed",
    });
    return getMpvState();
  }

  applyMpvInstallState({ command: candidate.option.command, method, status: "running" });

  const result = await runMpvInstall(candidate, onOutput);
  if (!result.ok) {
    applyMpvInstallState({ command: candidate.option.command, error: result.error, method, status: "failed" });
    return getMpvState();
  }

  applyMpvInstallState({ command: candidate.option.command, method, status: "succeeded" });
  // The freshly installed binary may sit somewhere the stale cache does not point at.
  updateMpvPathState({ cachedPath: null });
  return refreshMpvAvailability();
}

export function cancelMpvInstall(): void {
  cancelRunningInstall();
}

export function disposePlayer(): void {
  console.debug("[player][mpv][main]", "controller:dispose");

  cancelRunningInstall();
  metaBridgeDispose?.();
  metaBridgeDispose = undefined;
  queueBridgeDispose?.();
  queueBridgeDispose = undefined;
  nowPlayingBridgeDispose?.();
  nowPlayingBridgeDispose = undefined;
  volumeBridgeDispose?.();
  volumeBridgeDispose = undefined;
  volumePersistenceDispose?.();
  volumePersistenceDispose = undefined;
  clientSubscription?.();
  clientSubscription = undefined;
  disposeMpvIpcClient();
  streamSource = undefined;
  credentials = null;
  mpvPathStatePath = undefined;
  mpvPathState = createDefaultMpvPathState();
  resolvedMpvBinaryPath = null;
  pendingMpvResolution = undefined;
  resetPlayerSession();
}

export function setCredentials(nextCredentials: UserCredentialsToLogin | null): void {
  credentials = nextCredentials;
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

export async function setVolume(volumePercent: number): Promise<void> {
  return enqueue(async () => {
    const nextVolumePercent = clampVolumePercent(volumePercent);
    console.debug("[player][mpv][main]", "action:setVolume", { volumePercent: nextVolumePercent });

    await performSetVolume(nextVolumePercent);
  });
}

export async function setMuted(muted: boolean): Promise<void> {
  return enqueue(async () => {
    console.debug("[player][mpv][main]", "action:setMuted", { muted });

    await performSetMuted(muted);
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

function applyResolvedMpvState(state: MpvState): void {
  console.debug("[player][mpv][main]", "mpv:resolved", state);

  if (state.status === "ready") {
    resolvedMpvBinaryPath = state.binaryPath;
    // A bare `mpv` only works while PATH happens to contain it, so it is not worth caching.
    updateMpvPathState({ cachedPath: isAbsolute(state.binaryPath) ? state.binaryPath : null });
  } else {
    resolvedMpvBinaryPath = null;
    updateMpvPathState({ cachedPath: null });
  }

  applyMpvState(state);
}

function updateMpvPathState(patch: Partial<MpvPathState>): void {
  const nextState = { ...mpvPathState, ...patch };
  if (nextState.cachedPath === mpvPathState.cachedPath && nextState.manualPath === mpvPathState.manualPath) {
    return;
  }

  mpvPathState = nextState;
  if (!mpvPathStatePath) {
    return;
  }

  try {
    saveMpvPathState(mpvPathStatePath, mpvPathState);
  } catch (cause) {
    console.error("[player][mpv][main]", "mpv:path:persist:error", cause);
  }
}

/** Blocks playback with a useful message when no usable mpv binary is known. */
async function ensureMpvResolved(): Promise<void> {
  if (pendingMpvResolution) {
    await pendingMpvResolution;
  }

  if (getMpvState().status === "checking") {
    await refreshMpvAvailability();
  }

  const mpvState = getMpvState();
  if (mpvState.status === "ready") {
    return;
  }

  throw new MpvUnavailableError(getMpvUnavailableReason(mpvState) ?? "mpv is unavailable.");
}

function subscribeToStores(): void {
  if (metaBridgeDispose || queueBridgeDispose || nowPlayingBridgeDispose || volumeBridgeDispose) {
    return;
  }

  metaBridgeDispose = bridgeMainStoreToEvent({
    createEvent: (state) => ({ state, type: "meta" as const }),
    emitEvent: emitState,
    isEqual: isSamePlayerMetaState,
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
  volumeBridgeDispose = bridgeMainStoreToEvent({
    createEvent: (state) => ({ state, type: "volume" as const }),
    emitEvent: emitState,
    isEqual: isSameVolumeState,
    store: volumeStore,
  });
}

function subscribeToVolumePersistence(volumeStatePath: string): () => void {
  let previousState = volumeStore.state;

  const subscription = volumeStore.subscribe(() => {
    const nextState = volumeStore.state;
    if (isSameVolumeState(nextState, previousState)) {
      return;
    }

    previousState = nextState;
    try {
      savePlayerVolumeState(volumeStatePath, nextState);
    } catch (cause) {
      console.error("[player][mpv][main]", "volume:persist:error", cause);
    }
  });

  return () => {
    subscription.unsubscribe();
  };
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
    case "volume-change":
      handleVolumeChanged(event.volumePercent);
      return;
    case "mute-change":
      handleMutedChanged(event.muted);
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

    await ensureMpvResolved();

    const streamUrl = await nextStreamSource.getStreamUrl(currentTrack.id);
    console.debug("[player][mpv][main]", "track:load", {
      streamUrl,
      title: currentTrack.title,
      trackId: currentTrack.id,
    });

    await applyCurrentVolumeToMpv();
    if (options.resumePlayback) {
      await setMpvPause(false);
    }
    await loadMpvFile(streamUrl);
  } catch (cause) {
    applyError(cause);
  }
}

async function applyCurrentVolumeToMpv(): Promise<void> {
  await setMpvVolume(volumeStore.state.volumePercent);
  await setMpvMuted(volumeStore.state.muted);
}

async function setPause(paused: boolean): Promise<void> {
  ensureInitialized();

  try {
    console.debug("[player][mpv][main]", "track:setPause", { paused });
    await setMpvPause(paused);
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
    handleSeekApplied(boundedPosition);
  } catch (cause) {
    applyError(cause);
  }
}

async function performSetVolume(volumePercent: number): Promise<void> {
  ensureInitialized();

  try {
    console.debug("[player][mpv][main]", "track:setVolume", { volumePercent });
    await setMpvVolume(volumePercent);
    setVolumeRequested(volumePercent);
  } catch (cause) {
    applyError(cause);
  }
}

async function performSetMuted(muted: boolean): Promise<void> {
  ensureInitialized();

  try {
    console.debug("[player][mpv][main]", "track:setMuted", { muted });
    await setMpvMuted(muted);
    setMutedRequested(muted);
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

  // The binary went away or was never there: look again so the UI can offer a fix.
  if (isMpvResolutionError(cause) && getMpvState().status === "ready") {
    void refreshMpvAvailability();
  }
}

function ensureInitialized(): void {
  if (!streamSource) {
    throw new Error("Player module has not been initialized.");
  }
}

function isSameQueueState(nextState: PlayerQueueState, previousState: PlayerQueueState): boolean {
  return (
    nextState.currentIndex === previousState.currentIndex &&
    nextState.currentTrackId === previousState.currentTrackId &&
    isSameQueueContext(nextState.context, previousState.context) &&
    nextState.queue.length === previousState.queue.length &&
    nextState.queue.every((trackId, index) => trackId === previousState.queue[index])
  );
}

function isSameQueueContext(nextContext: PlayerQueueState["context"], previousContext: PlayerQueueState["context"]): boolean {
  if (nextContext?.type !== previousContext?.type) return false;
  if (nextContext === null || previousContext === null) return true;
  if (nextContext.type === "album" && previousContext.type === "album") return nextContext.albumId === previousContext.albumId;
  if (nextContext.type !== "playlist" || previousContext.type !== "playlist") return false;
  return (
    nextContext.playlistId === previousContext.playlistId &&
    nextContext.entryIds.length === previousContext.entryIds.length &&
    nextContext.entryIds.every((entryId, index) => entryId === previousContext.entryIds[index])
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

function isSameVolumeState(nextState: PlayerState["volume"], previousState: PlayerState["volume"]): boolean {
  return nextState.volumePercent === previousState.volumePercent && nextState.muted === previousState.muted;
}

function isPositionOnlyNowPlayingChange(nextState: PlayerNowPlayingState, previousState: PlayerNowPlayingState): boolean {
  return (
    nextState.positionSeconds !== previousState.positionSeconds &&
    nextState.durationSeconds === previousState.durationSeconds &&
    nextState.error === previousState.error &&
    nextState.status === previousState.status
  );
}
