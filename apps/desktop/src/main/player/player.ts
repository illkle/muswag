import { createStore } from "@tanstack/react-store";
import type { UserCredentialsToLogin } from "@muswag/shared";

import type { MpvInstallMethod, MpvState, PlayQueueInput, PlayerEvent, PlayerMetaState, PlayerState, PlayerVolumeState } from "../../shared/player";
import {
  createDefaultPlayerMetaState,
  createDefaultPlayerVolumeState,
  getMpvUnavailableReason,
  isSameNowPlayingState,
  isSamePlayerMetaState,
  isSamePositionOnlyChange,
  isSameQueueState,
  isSameVolumeState,
} from "../../shared/player";
import { bridgeMainStoreToEvent } from "../../shared/store-sync";
import { detectInstallCandidates, type MpvInstallCandidate } from "./binary/install-catalog";
import { MpvBinaryManager } from "./binary/mpv-binary-manager";
import { MpvInstaller, type MpvInstallOutput } from "./binary/mpv-installer";
import { createMpvLocatorDeps } from "./binary/mpv-locator";
import { isMpvResolutionError, MpvUnavailableError } from "./errors";
import { MpvClient, type MpvClientEvent } from "./mpv/mpv-client";
import { PlayerSession, type TrackSelection } from "./session/player-session";
import { resolveStreamUrl } from "./stream-source";
import { createJsonFileStore } from "./support/json-file-store";
import { SerialQueue } from "./support/serial-queue";

const POSITION_BROADCAST_INTERVAL_MS = 500;

export type PlayerOptions = { ipcPath: string; mpvPathStatePath: string; volumeStatePath: string };

export type PlayerDeps = {
  session: PlayerSession;
  client: MpvClient;
  binaries: MpvBinaryManager;
  installer: MpvInstaller;
  resolveStreamUrl: typeof resolveStreamUrl;
  detectInstallCandidates: () => Promise<MpvInstallCandidate[]>;
};

export function parsePlayerVolumeState(value: unknown): PlayerVolumeState {
  const fallback = createDefaultPlayerVolumeState();
  if (!value || typeof value !== "object") return fallback;
  const state = value as Partial<Record<keyof PlayerVolumeState, unknown>>;
  return {
    muted: typeof state.muted === "boolean" ? state.muted : fallback.muted,
    volumePercent: typeof state.volumePercent === "number" && Number.isFinite(state.volumePercent) ? Math.min(100, Math.max(0, Math.round(state.volumePercent))) : fallback.volumePercent,
  };
}

export class Player {
  private readonly session: PlayerSession;
  private readonly client: MpvClient;
  private readonly binaries: MpvBinaryManager;
  private readonly installer: MpvInstaller;
  private readonly streamResolver: typeof resolveStreamUrl;
  private readonly installCatalog: () => Promise<MpvInstallCandidate[]>;
  private readonly operationQueue = new SerialQueue();
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly metaStore;
  private readonly disposeCallbacks: Array<() => void> = [];
  private credentials: UserCredentialsToLogin | null = null;
  private disposed = false;

  constructor(options: PlayerOptions, deps: Partial<PlayerDeps> = {}) {
    this.session = deps.session ?? new PlayerSession();
    this.binaries = deps.binaries ?? new MpvBinaryManager({ statePath: options.mpvPathStatePath });
    this.installer = deps.installer ?? new MpvInstaller();
    this.client = deps.client ?? new MpvClient({ ipcPath: options.ipcPath, getBinaryPath: () => this.binaries.binaryPath });
    this.streamResolver = deps.resolveStreamUrl ?? resolveStreamUrl;
    this.installCatalog = deps.detectInstallCandidates ?? (() => detectInstallCandidates(createMpvLocatorDeps()));
    this.metaStore = createStore<PlayerMetaState>({ mpv: this.binaries.store.state, mpvInstall: this.installer.store.state });

    const volumeFile = createJsonFileStore(options.volumeStatePath, parsePlayerVolumeState);
    this.session.restoreVolume(volumeFile.load());
    this.wireMetaStores();
    this.wireStateEvents();
    this.wireVolumePersistence(volumeFile);
    this.disposeCallbacks.push(this.client.subscribe((event) => this.handleClientEvent(event)));
    void this.binaries.refresh().catch((cause) => console.error("[player][mpv] initial resolution failed", cause));
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlayerState {
    const session = this.session.getState();
    return { meta: { ...this.metaStore.state }, ...session };
  }

  getMpvState(): MpvState {
    return this.binaries.store.state;
  }

  setCredentials(credentials: UserCredentialsToLogin | null): void {
    this.credentials = credentials;
  }

  playQueue(input: PlayQueueInput): Promise<void> {
    return this.operationQueue.run(async () => {
      if (input.queue.length === 0) {
        try {
          await this.client.stop();
        } catch {
          // Clearing an already unavailable player is still successful.
        }
        this.session.clear();
        return;
      }
      const selection = this.session.loadQueue(input);
      if (selection) await this.loadSelection(selection);
    });
  }

  play(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.session.currentTrack) return;
      if (this.session.status === "ended") {
        const selection = this.session.reloadCurrent({ resume: true });
        if (selection) await this.loadSelection(selection);
        return;
      }
      await this.setPause(false);
    });
  }

  pause(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (this.session.currentTrack) await this.setPause(true);
    });
  }

  toggle(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.session.currentTrack) return;
      if (this.session.status === "ended") {
        const selection = this.session.reloadCurrent({ resume: true });
        if (selection) await this.loadSelection(selection);
        return;
      }
      await this.setPause(this.session.status !== "paused");
    });
  }

  seek(positionSeconds: number): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.session.currentTrack) return;
      const position = this.session.clampPosition(positionSeconds);
      try {
        await this.client.seek(position);
        this.session.seekApplied(position);
      } catch (cause) {
        this.handleFailure(cause);
      }
    });
  }

  setVolume(volumePercent: number): Promise<void> {
    return this.operationQueue.run(async () => {
      const volume = this.session.clampVolume(volumePercent);
      try {
        await this.client.setVolume(volume);
        this.session.volumeRequested(volume);
      } catch (cause) {
        this.handleFailure(cause);
      }
    });
  }

  setMuted(muted: boolean): Promise<void> {
    return this.operationQueue.run(async () => {
      try {
        await this.client.setMuted(muted);
        this.session.mutedRequested(muted);
      } catch (cause) {
        this.handleFailure(cause);
      }
    });
  }

  next(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.session.currentTrack) return;
      const selection = this.session.next({ resume: this.session.status !== "paused" });
      if (selection) await this.loadSelection(selection);
    });
  }

  previous(): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.session.currentTrack) return;
      const selection = this.session.previous({ resume: this.session.status !== "paused" });
      if (selection === "restart") {
        try {
          await this.client.seek(0);
          this.session.seekApplied(0);
        } catch (cause) {
          this.handleFailure(cause);
        }
      } else if (selection) {
        await this.loadSelection(selection);
      }
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
      this.installer.fail(
        {
          option: { automatic: false, command: method, method, note: null, url: null },
        },
        `${method} is not available on this machine.`,
      );
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
    this.client.dispose();
    this.session.reset();
    this.metaStore.setState(() => createDefaultPlayerMetaState());
    this.credentials = null;
    this.listeners.clear();
  }

  private async loadSelection(selection: TrackSelection): Promise<void> {
    try {
      await this.ensureMpvReady();
      const url = this.streamResolver(this.credentials, selection.track.id);
      const volume = this.session.volumeStore.state;
      await this.client.setVolume(volume.volumePercent);
      await this.client.setMuted(volume.muted);
      if (selection.resume) await this.client.setPause(false);
      await this.client.loadFile(url);
    } catch (cause) {
      this.handleFailure(cause);
    }
  }

  private async ensureMpvReady(): Promise<void> {
    let state = this.binaries.store.state;
    if (state.status === "checking") state = await this.binaries.refresh();
    if (state.status !== "ready") {
      throw new MpvUnavailableError(getMpvUnavailableReason(state) ?? "mpv is unavailable.");
    }
  }

  private async setPause(paused: boolean): Promise<void> {
    try {
      await this.client.setPause(paused);
      this.session.pauseRequested(paused);
    } catch (cause) {
      this.handleFailure(cause);
    }
  }

  private handleFailure(cause: unknown): void {
    console.error("[player][mpv] playback failed", cause);
    this.session.fail(cause instanceof Error ? cause.message : "Playback failed");
    if (isMpvResolutionError(cause) && this.binaries.store.state.status === "ready") {
      void this.binaries.invalidate().catch((error) => console.error("[player][mpv] re-resolution failed", error));
    }
  }

  private handleClientEvent(event: MpvClientEvent): void {
    switch (event.type) {
      case "pause-change":
        this.session.pauseChanged(event.paused);
        return;
      case "time-pos-change":
        this.session.positionChanged(event.positionSeconds);
        return;
      case "duration-change":
        this.session.durationChanged(event.durationSeconds);
        return;
      case "volume-change":
        this.session.volumeChanged(event.volumePercent);
        return;
      case "mute-change":
        this.session.mutedChanged(event.muted);
        return;
      case "file-loaded":
        this.session.fileLoaded();
        return;
      case "end-file":
        if (event.reason === "eof") {
          void this.operationQueue.run(async () => {
            const selection = this.session.next({ resume: true });
            if (selection) await this.loadSelection(selection);
            else this.session.playbackEnded();
          });
        }
        return;
      case "exited":
        if (!event.expected) this.session.fail("mpv exited unexpectedly.");
        return;
      case "error":
        this.handleFailure(event.cause);
        return;
    }
  }

  private wireMetaStores(): void {
    const binarySubscription = this.binaries.store.subscribe(() => {
      this.metaStore.setState((state) => ({ ...state, mpv: this.binaries.store.state }));
    });
    const installerSubscription = this.installer.store.subscribe(() => {
      this.metaStore.setState((state) => ({ ...state, mpvInstall: this.installer.store.state }));
    });
    this.disposeCallbacks.push(
      () => binarySubscription.unsubscribe(),
      () => installerSubscription.unsubscribe(),
    );
  }

  private wireStateEvents(): void {
    const bridge = <T>(options: Parameters<typeof bridgeMainStoreToEvent<T, PlayerEvent>>[0]) => this.disposeCallbacks.push(bridgeMainStoreToEvent(options));
    bridge({ createEvent: (state) => ({ state, type: "meta" }), emitEvent: (event) => this.emit(event), isEqual: isSamePlayerMetaState, store: this.metaStore });
    bridge({ createEvent: (state) => ({ state, type: "queue" }), emitEvent: (event) => this.emit(event), isEqual: isSameQueueState, store: this.session.queueStore });
    bridge({
      createEvent: (state) => ({ state, type: "nowPlaying" }),
      emitEvent: (event) => this.emit(event),
      isEqual: isSameNowPlayingState,
      shouldThrottle: isSamePositionOnlyChange,
      store: this.session.nowPlayingStore,
      throttleMs: POSITION_BROADCAST_INTERVAL_MS,
    });
    bridge({ createEvent: (state) => ({ state, type: "volume" }), emitEvent: (event) => this.emit(event), isEqual: isSameVolumeState, store: this.session.volumeStore });
  }

  private wireVolumePersistence(volumeFile: { save(state: PlayerVolumeState): void }): void {
    let previous = this.session.volumeStore.state;
    const subscription = this.session.volumeStore.subscribe(() => {
      const next = this.session.volumeStore.state;
      if (isSameVolumeState(next, previous)) return;
      previous = next;
      try {
        volumeFile.save(next);
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
