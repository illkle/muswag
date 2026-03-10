import { Player } from "#/lib/db";
import type { PlayQueueInput, PlayerState } from "#/shared/player";
import { createDefaultPlayerState } from "#/shared/player";

type Listener = () => void;

class PlayerStore {
  private state: PlayerState = createDefaultPlayerState();
  private initialized = false;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<Listener>();

  initialize(): void {
    if (this.initialized) {
      logPlayerDebug("initialize:skip", { reason: "already_initialized" });
      return;
    }

    this.initialized = true;
    logPlayerDebug("initialize:start");

    void Player.getState()
      .then((nextState) => {
        logPlayerDebug("ipc:getState:success", summarizeState(nextState));
        this.setState(nextState);
      })
      .catch((cause) => {
        logPlayerError("ipc:getState:error", cause);
        this.setState(createErrorState(cause));
      });

    this.unsubscribe = Player.subscribe((event) => {
      logPlayerDebug("ipc:event", summarizeEvent(event));
      if (event.type === "state") {
        this.setState(event.state);
      }
    });
  }

  dispose(): void {
    logPlayerDebug("dispose");
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.initialized = false;
  }

  getState(): PlayerState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    logPlayerDebug("subscribe", { listeners: this.listeners.size });

    return () => {
      this.listeners.delete(listener);
      logPlayerDebug("unsubscribe", { listeners: this.listeners.size });
    };
  }

  async next(): Promise<PlayerState> {
    return this.invoke(() => Player.next());
  }

  async pause(): Promise<PlayerState> {
    return this.invoke(() => Player.pause());
  }

  async play(): Promise<PlayerState> {
    return this.invoke(() => Player.play());
  }

  async playQueue(input: PlayQueueInput): Promise<PlayerState> {
    return this.invoke(() => Player.playQueue(input));
  }

  async previous(): Promise<PlayerState> {
    return this.invoke(() => Player.previous());
  }

  async seek(positionSeconds: number): Promise<PlayerState> {
    return this.invoke(() => Player.seek(positionSeconds));
  }

  async toggle(): Promise<PlayerState> {
    return this.invoke(() => Player.toggle());
  }

  private async invoke(action: () => Promise<PlayerState>): Promise<PlayerState> {
    try {
      logPlayerDebug("action:start");
      const nextState = await action();
      logPlayerDebug("action:success", summarizeState(nextState));
      this.setState(nextState);
      return nextState;
    } catch (cause) {
      logPlayerError("action:error", cause);
      const nextState = createErrorState(cause);
      this.setState(nextState);
      return nextState;
    }
  }

  private setState(nextState: PlayerState): void {
    this.state = nextState;
    //logPlayerDebug("state:update", summarizeState(nextState));

    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const playerStore = new PlayerStore();

export const playerActions = {
  next: () => invokeWithLog("next", () => playerStore.next()),
  pause: () => invokeWithLog("pause", () => playerStore.pause()),
  play: () => invokeWithLog("play", () => playerStore.play()),
  playQueue: (input: PlayQueueInput) =>
    invokeWithLog("playQueue", () => playerStore.playQueue(input), {
      queueLength: input.queue.length,
      startIndex: input.startIndex,
      startTrackId: input.queue[input.startIndex]?.id ?? null,
    }),
  previous: () => invokeWithLog("previous", () => playerStore.previous()),
  seek: (positionSeconds: number) =>
    invokeWithLog("seek", () => playerStore.seek(positionSeconds), { positionSeconds }),
  toggle: () => invokeWithLog("toggle", () => playerStore.toggle()),
};

export function createErrorState(cause: unknown): PlayerState {
  const state = createDefaultPlayerState();
  const message = cause instanceof Error ? cause.message : "Playback is unavailable.";

  return {
    ...state,
    status: "error",
    error: message,
    mpvAvailable: !message.includes("No handler registered"),
  };
}

async function invokeWithLog<T>(
  action: string,
  invoke: () => Promise<T>,
  payload?: Record<string, unknown>,
): Promise<T> {
  logPlayerDebug(`ui:${action}`, payload);
  return invoke();
}

function summarizeState(state: PlayerState): Record<string, unknown> {
  return {
    status: state.status,
    currentIndex: state.currentIndex,
    currentTrackId: state.currentTrack?.id ?? null,
    currentTrackTitle: state.currentTrack?.title ?? null,
    queueLength: state.queue.length,
    positionSeconds: roundSeconds(state.positionSeconds),
    durationSeconds: roundSeconds(state.durationSeconds),
    error: state.error,
    mpvAvailable: state.mpvAvailable,
  };
}

function summarizeEvent(event: { type: string; state?: PlayerState }): Record<string, unknown> {
  return event.type === "state" && event.state
    ? { type: event.type, ...summarizeState(event.state) }
    : { type: event.type };
}

function roundSeconds(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function logPlayerDebug(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.debug("[player][renderer]", message, payload);
    return;
  }

  console.debug("[player][renderer]", message);
}

function logPlayerError(message: string, cause: unknown): void {
  console.error("[player][renderer]", message, cause);
}
