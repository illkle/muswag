import { createStore } from "@tanstack/react-store";
import { clonePlaybackItem, type SessionCredentials } from "@muswag/shared";

import type { ApplyMpvQueueInput, MpvInstallMethod, MpvState, PlayerEvent, PlayerMetaState, PlayerRuntimeState, PlayerState } from "#shared/player";
import { createDefaultPlayerMetaState, createDefaultPlayerRuntimeState, getMpvUnavailableReason, isSamePlayerMetaState } from "#shared/player";
import { SerialQueue } from "#shared/serial-queue";
import { bridgeMainStoreToEvent } from "#shared/store-sync";
import { detectInstallCandidates, type MpvInstallCandidate } from "./binary/install-catalog";
import { MpvBinaryManager } from "./binary/mpv-binary-manager";
import { MpvInstaller, type MpvInstallOutput } from "./binary/mpv-installer";
import { createMpvLocatorDeps } from "./binary/mpv-locator";
import { isMpvResolutionError, MPV_ENTRY_ID_UNSUPPORTED, MpvUnavailableError } from "./errors";
import { MpvClient, type MpvClientEvent } from "./mpv/mpv-client";
import { MpvQueueMirror } from "./mpv/mpv-queue-mirror";
import { resolveStreamUrl } from "./stream-source";
import { createJsonFileStore } from "./support/json-file-store";

const POSITION_BROADCAST_INTERVAL_MS = 500;
const MPV_FILE_ERROR = "mpv failed to play the track.";

type LifecycleEvent = Extract<MpvClientEvent, { type: "start-file" | "file-loaded" | "end-file" }>;
type StoredVolume = Pick<PlayerRuntimeState, "volumePercent" | "muted">;

export type PlayerOptions = { ipcPath: string; mpvPathStatePath: string; volumeStatePath: string };

export type PlayerDeps = {
  client: MpvClient;
  mirror: MpvQueueMirror;
  binaries: MpvBinaryManager;
  installer: MpvInstaller;
  resolveStreamUrl: typeof resolveStreamUrl;
  detectInstallCandidates: () => Promise<MpvInstallCandidate[]>;
};

export function parsePlayerVolumeState(value: unknown): StoredVolume {
  const fallback = { muted: false, volumePercent: 100 };
  if (!value || typeof value !== "object") return fallback;
  const state = value as Partial<Record<keyof StoredVolume, unknown>>;
  return {
    muted: typeof state.muted === "boolean" ? state.muted : fallback.muted,
    volumePercent: typeof state.volumePercent === "number" && Number.isFinite(state.volumePercent) ? clampVolume(state.volumePercent, fallback.volumePercent) : fallback.volumePercent,
  };
}

export class Player {
  private readonly client: MpvClient;
  private readonly mirror: MpvQueueMirror;
  private readonly binaries: MpvBinaryManager;
  private readonly installer: MpvInstaller;
  private readonly streamResolver: typeof resolveStreamUrl;
  private readonly installCatalog: () => Promise<MpvInstallCandidate[]>;
  private readonly operationQueue = new SerialQueue();
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly metaStore;
  private readonly runtimeStore;
  private readonly disposeCallbacks: Array<() => void> = [];
  private readonly volumeFile;
  private credentials: SessionCredentials | null = null;
  private desiredPaused = false;
  private pendingRestore: { key: string; positionSeconds: number } | null = null;
  private pendingMirrorCommands = 0;
  private deferredLifecycleEvents: LifecycleEvent[] = [];
  private positionBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private retriedKey: string | null = null;
  private recoveringKey: string | null = null;
  private disposed = false;

  constructor(options: PlayerOptions, deps: Partial<PlayerDeps> = {}) {
    this.binaries = deps.binaries ?? new MpvBinaryManager({ statePath: options.mpvPathStatePath });
    this.installer = deps.installer ?? new MpvInstaller();
    this.client = deps.client ?? new MpvClient({ ipcPath: options.ipcPath, getBinaryPath: () => this.binaries.binaryPath });
    this.streamResolver = deps.resolveStreamUrl ?? resolveStreamUrl;
    this.installCatalog = deps.detectInstallCandidates ?? (() => detectInstallCandidates(createMpvLocatorDeps()));
    this.mirror = deps.mirror ?? new MpvQueueMirror({ client: this.client, resolveUrl: (trackId) => this.streamResolver(this.credentials, trackId) });
    this.metaStore = createStore<PlayerMetaState>({ mpv: this.binaries.store.state, mpvInstall: this.installer.store.state });
    this.volumeFile = createJsonFileStore(options.volumeStatePath, parsePlayerVolumeState);
    const volume = this.volumeFile.load();
    this.runtimeStore = createStore<PlayerRuntimeState>({ ...createDefaultPlayerRuntimeState(), ...volume });

    this.wireMetaStores();
    this.wireVolumePersistence();
    this.disposeCallbacks.push(this.client.subscribe((event) => this.handleClientEvent(event)));
    void this.binaries.refresh().catch((cause) => console.error("[player][mpv] initial resolution failed", cause));
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlayerState {
    return { meta: { ...this.metaStore.state }, runtime: cloneRuntime(this.runtimeStore.state) };
  }

  getRuntimeState(): PlayerRuntimeState {
    return cloneRuntime(this.runtimeStore.state);
  }

  getMpvState(): MpvState {
    return this.binaries.store.state;
  }

  applyQueue(input: ApplyMpvQueueInput): Promise<void> {
    return this.operationQueue.run(async () => {
      try {
        await this.ensureMpvReady();
        await this.client.setVolume(this.runtimeStore.state.volumePercent);
        await this.client.setMuted(this.runtimeStore.state.muted);
        if (input.select) {
          this.desiredPaused = !input.select.play;
          this.pendingRestore = { key: input.select.key, positionSeconds: clampPosition(input.select.positionSeconds ?? 0, null) };
          await this.client.setPause(this.desiredPaused);
        }
        await this.runMirrorTransaction(() => this.mirror.apply(input));
      } catch (cause) {
        this.handleFailure(cause, true);
        throw cause;
      }
    });
  }

  restartCurrent(): Promise<void> {
    return this.operationQueue.run(async () => {
      this.pendingRestore = this.mirror.currentEntry ? { key: this.mirror.currentEntry.key, positionSeconds: 0 } : null;
      await this.runMirrorTransaction(() => this.mirror.restartCurrent());
    });
  }

  stop(): Promise<void> {
    return this.operationQueue.run(async () => this.stopAndReset());
  }

  setCredentials(credentials: SessionCredentials | null): Promise<void> {
    const next = credentials ? { ...credentials } : null;
    return this.operationQueue.run(async () => {
      if (areCredentialsEqual(this.credentials, next)) return;
      this.credentials = next;
      if (!next) {
        await this.stopAndReset();
        return;
      }
      if (this.client.state === "ready" && this.mirror.currentEntry) {
        await this.runMirrorTransaction(() => this.mirror.rebuildUrls());
      }
    });
  }

  play(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.runtimeStore.state.current) return;
      if (this.runtimeStore.state.status === "ended") {
        this.desiredPaused = false;
        await this.runMirrorTransaction(() => this.mirror.restartCurrent());
      } else {
        await this.setPause(false);
      }
    });
  }

  pause(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (this.runtimeStore.state.current) await this.setPause(true);
    });
  }

  toggle(): Promise<void> {
    return this.runtimeStore.state.paused || this.runtimeStore.state.status === "ended" ? this.play() : this.pause();
  }

  seek(positionSeconds: number): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.runtimeStore.state.current) return;
      const position = clampPosition(positionSeconds, this.runtimeStore.state.durationSeconds);
      await this.client.seek(position);
      this.updateRuntime({ positionSeconds: position }, true);
    });
  }

  setVolume(volumePercent: number): Promise<void> {
    return this.operationQueue.run(async () => {
      const volume = clampVolume(volumePercent, this.runtimeStore.state.volumePercent);
      await this.client.setVolume(volume);
      this.updateRuntime({ volumePercent: volume });
    });
  }

  setMuted(muted: boolean): Promise<void> {
    return this.operationQueue.run(async () => {
      await this.client.setMuted(muted);
      this.updateRuntime({ muted });
    });
  }

  refreshMpvAvailability(): Promise<MpvState> {
    return this.binaries.refresh();
  }

  setManualMpvPath(binaryPath: string): Promise<MpvState> {
    return this.binaries.setManualPath(binaryPath);
  }

  clearManualMpvPath(): Promise<MpvState> {
    return this.binaries.clearManualPath();
  }

  async installMpv(method: MpvInstallMethod, onOutput: (output: MpvInstallOutput) => void): Promise<MpvState> {
    const candidate = (await this.installCatalog()).find(({ option }) => option.method === method);
    if (!candidate) {
      this.installer.fail({ option: { automatic: false, command: method, method, note: null, url: null } }, `${method} is not available on this machine.`);
      return this.getMpvState();
    }
    const result = await this.installer.install(candidate, onOutput);
    return result.ok ? this.binaries.invalidate() : this.getMpvState();
  }

  cancelMpvInstall(): void {
    this.installer.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.installer.cancel();
    for (const dispose of this.disposeCallbacks.splice(0)) dispose();
    if (this.positionBroadcastTimer) clearTimeout(this.positionBroadcastTimer);
    this.client.dispose();
    this.metaStore.setState(() => createDefaultPlayerMetaState());
    this.runtimeStore.setState(() => createDefaultPlayerRuntimeState());
    this.credentials = null;
    this.listeners.clear();
  }

  private async ensureMpvReady(): Promise<void> {
    let state = this.binaries.store.state;
    if (state.status === "checking") state = await this.binaries.refresh();
    if (state.status !== "ready") throw new MpvUnavailableError(getMpvUnavailableReason(state) ?? "mpv is unavailable.");
  }

  private async setPause(paused: boolean): Promise<void> {
    this.desiredPaused = paused;
    await this.client.setPause(paused);
    this.updateRuntime({ paused, status: paused ? "paused" : "playing" });
  }

  private handleClientEvent(event: MpvClientEvent): void {
    if (isLifecycleEvent(event) && this.pendingMirrorCommands > 0) {
      this.deferredLifecycleEvents.push(event);
      return;
    }
    switch (event.type) {
      case "start-file":
        this.handleStartFile(event.playlistEntryId);
        return;
      case "file-loaded":
        this.handleFileLoaded();
        return;
      case "end-file":
        this.handleEndFile(event);
        return;
      case "pause-change":
        if (this.runtimeStore.state.status !== "loading" && this.runtimeStore.state.status !== "ended") {
          this.desiredPaused = event.paused;
          this.updateRuntime({ paused: event.paused, status: event.paused ? "paused" : "playing" });
        }
        return;
      case "time-pos-change":
        if (event.positionSeconds !== null && this.runtimeStore.state.current) this.updateRuntime({ positionSeconds: event.positionSeconds }, true);
        return;
      case "duration-change":
        if (event.durationSeconds !== null && this.runtimeStore.state.current) this.updateRuntime({ durationSeconds: event.durationSeconds });
        return;
      case "volume-change":
        this.updateRuntime({ volumePercent: clampVolume(event.volumePercent, this.runtimeStore.state.volumePercent) });
        return;
      case "mute-change":
        this.updateRuntime({ muted: event.muted });
        return;
      case "exited":
        if (!event.expected) this.handleFailure(new Error("mpv exited unexpectedly."), false);
        return;
      case "error":
        this.handleFailure(event.cause, false);
        return;
    }
  }

  private handleStartFile(playlistEntryId: number | null): void {
    if (!isEntryId(playlistEntryId)) {
      this.handleFailure(new Error(MPV_ENTRY_ID_UNSUPPORTED), true);
      return;
    }
    const entry = this.mirror.entryForId(playlistEntryId);
    if (!entry) {
      console.debug("[player][mpv] ignored stale start-file", playlistEntryId);
      return;
    }
    if (this.recoveringKey && entry.key !== this.recoveringKey) {
      console.debug("[player][mpv] ignored automatic advance while retrying", entry.key);
      return;
    }
    if (!this.mirror.setCurrentEntryId(playlistEntryId)) return;
    this.recoveringKey = null;
    const restorePosition = this.pendingRestore?.key === entry.key ? this.pendingRestore.positionSeconds : 0;
    if (this.runtimeStore.state.current?.key !== entry.key) this.retriedKey = null;
    this.updateRuntime({
      current: clonePlaybackItem(entry),
      status: "loading",
      error: null,
      positionSeconds: restorePosition,
      durationSeconds: entry.track.duration ?? null,
      paused: this.desiredPaused,
    });
  }

  private handleFileLoaded(): void {
    if (!this.runtimeStore.state.current || this.runtimeStore.state.status !== "loading") return;
    const pending = this.pendingRestore?.key === this.runtimeStore.state.current.key ? this.pendingRestore : null;
    this.pendingRestore = null;
    this.updateRuntime({ status: this.desiredPaused ? "paused" : "playing", paused: this.desiredPaused, error: null });
    void this.operationQueue.run(async () => {
      if (pending && pending.positionSeconds > 0) await this.client.seek(pending.positionSeconds);
      await this.client.setPause(this.desiredPaused);
    });
  }

  private handleEndFile(event: Extract<MpvClientEvent, { type: "end-file" }>): void {
    if (event.reason === "stop" || event.reason === "quit" || event.reason === "redirect") return;
    if (!isEntryId(event.playlistEntryId)) {
      this.handleFailure(new Error(MPV_ENTRY_ID_UNSUPPORTED), true);
      return;
    }
    if (!this.mirror.entryForId(event.playlistEntryId)) return;
    const isCurrent = this.mirror.currentEntry?.playlistEntryId === event.playlistEntryId;
    if (!isCurrent) return;
    if (event.reason === "eof") {
      if (!this.mirror.hasSuccessor(event.playlistEntryId)) {
        this.updateRuntime({ status: "ended", positionSeconds: this.runtimeStore.state.durationSeconds ?? this.runtimeStore.state.positionSeconds });
      }
      return;
    }
    if (event.reason !== "error") return;
    const currentKey = this.runtimeStore.state.current?.key;
    if (currentKey && this.retriedKey !== currentKey) {
      this.retriedKey = currentKey;
      this.recoveringKey = currentKey;
      void this.operationQueue.run(async () => {
        try {
          await this.runMirrorTransaction(() => this.mirror.reloadCurrent());
        } catch (cause) {
          this.recoveringKey = null;
          this.handleFailure(cause, true);
        }
      });
      return;
    }
    this.handleFailure(new Error(event.fileError ?? MPV_FILE_ERROR), true);
  }

  private handleFailure(cause: unknown, stop: boolean): void {
    console.error("[player][mpv] playback failed", cause);
    this.updateRuntime({ error: cause instanceof Error ? cause.message : "Playback failed", status: "error" });
    if (stop) void this.operationQueue.run(async () => this.stopClientOnly());
    if (isMpvResolutionError(cause) && this.binaries.store.state.status === "ready") {
      void this.binaries.invalidate().catch((error) => console.error("[player][mpv] re-resolution failed", error));
    }
  }

  private async stopAndReset(): Promise<void> {
    await this.stopClientOnly();
    try {
      await this.runMirrorTransaction(() => this.mirror.clear());
    } catch {
      // MpvQueueMirror clears its in-memory correlations in finally.
    }
    this.desiredPaused = false;
    this.pendingRestore = null;
    this.retriedKey = null;
    this.recoveringKey = null;
    this.updateRuntime({ ...createDefaultPlayerRuntimeState(), ...this.volumeState });
  }

  private async stopClientOnly(): Promise<void> {
    try {
      await this.client.stop();
    } catch {
      // Stopping an already unavailable client is idempotent from the app's perspective.
    }
  }

  private async runMirrorTransaction(operation: () => Promise<void>): Promise<void> {
    this.pendingMirrorCommands += 1;
    try {
      await operation();
    } finally {
      this.pendingMirrorCommands -= 1;
      if (this.pendingMirrorCommands === 0) {
        const deferred = this.deferredLifecycleEvents;
        this.deferredLifecycleEvents = [];
        for (const event of deferred) this.handleClientEvent(event);
      }
    }
  }

  private updateRuntime(patch: Partial<PlayerRuntimeState>, positionOnly = false): void {
    const next = { ...this.runtimeStore.state, ...patch, sequence: this.runtimeStore.state.sequence + 1 };
    this.runtimeStore.setState(() => next);
    if (positionOnly) {
      if (!this.positionBroadcastTimer) {
        this.positionBroadcastTimer = setTimeout(() => {
          this.positionBroadcastTimer = null;
          this.emit({ type: "runtime", state: cloneRuntime(this.runtimeStore.state) });
        }, POSITION_BROADCAST_INTERVAL_MS);
      }
      return;
    }
    if (this.positionBroadcastTimer) {
      clearTimeout(this.positionBroadcastTimer);
      this.positionBroadcastTimer = null;
    }
    this.emit({ type: "runtime", state: cloneRuntime(next) });
  }

  private wireMetaStores(): void {
    const binarySubscription = this.binaries.store.subscribe(() => this.metaStore.setState((state) => ({ ...state, mpv: this.binaries.store.state })));
    const installerSubscription = this.installer.store.subscribe(() => this.metaStore.setState((state) => ({ ...state, mpvInstall: this.installer.store.state })));
    this.disposeCallbacks.push(
      () => binarySubscription.unsubscribe(),
      () => installerSubscription.unsubscribe(),
      bridgeMainStoreToEvent({
        createEvent: (state) => ({ state, type: "meta" as const }),
        emitEvent: (event) => this.emit(event),
        isEqual: isSamePlayerMetaState,
        store: this.metaStore,
      }),
    );
  }

  private get volumeState(): StoredVolume {
    const { muted, volumePercent } = this.runtimeStore.state;
    return { muted, volumePercent };
  }

  private wireVolumePersistence(): void {
    let previous = this.volumeState;
    const subscription = this.runtimeStore.subscribe(() => {
      const next = this.volumeState;
      if (next.muted === previous.muted && next.volumePercent === previous.volumePercent) return;
      previous = next;
      try {
        this.volumeFile.save(next);
      } catch (cause) {
        console.error("[player][mpv] volume persistence failed", cause);
      }
    });
    this.disposeCallbacks.push(() => subscription.unsubscribe());
  }

  private emit(event: PlayerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isLifecycleEvent(event: MpvClientEvent): event is LifecycleEvent {
  return event.type === "start-file" || event.type === "file-loaded" || event.type === "end-file";
}

function isEntryId(value: number | null): value is number {
  return Number.isSafeInteger(value);
}

function clampPosition(value: number, duration: number | null): number {
  const finite = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(finite, duration ?? finite));
}

function clampVolume(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;
}

function cloneRuntime(state: PlayerRuntimeState): PlayerRuntimeState {
  return structuredClone(state);
}

function areCredentialsEqual(left: SessionCredentials | null, right: SessionCredentials | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.url === right.url && left.username === right.username && left.password === right.password;
}
