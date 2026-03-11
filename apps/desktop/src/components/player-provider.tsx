import { Player } from "#/lib/db";
import { createDefaultPlayerState } from "#/shared/player";
import { createStore, useStore } from "@tanstack/react-store";

const defaultState = createDefaultPlayerState();

const PlayerStore = createStore(defaultState);

void Player.getState()
  .then((nextState) => {
    PlayerStore.setState(() => nextState);
  })
  .catch((cause) => {
    console.error(cause);
  });

Player.subscribe((event) => {
  if (event.type === "state") {
    PlayerStore.setState(() => event.state);
  }
});

export function usePlayerCurrentIndex() {
  return useStore(PlayerStore, (v) => v.currentIndex);
}

export function usePlayerQueue() {
  return useStore(PlayerStore, (v) => v.queue);
}

export function usePlayerCurrentTrackId() {
  return useStore(PlayerStore, (v) => v.currentTrackId);
}

export function usePlayerStatus() {
  return useStore(PlayerStore, (v) => v.status);
}

export function usePlayerCanPlay() {
  return useStore(PlayerStore, (v) => v.canPlay);
}

export function usePlayerCanGoForward() {
  return useStore(PlayerStore, (v) => v.canGoForward);
}

export function usePlayerCanGoBack() {
  return useStore(PlayerStore, (v) => v.canGoBack);
}

export function usePlayerCanSeek() {
  return useStore(PlayerStore, (v) => v.canSeek);
}

export function usePlayerDuration() {
  return useStore(PlayerStore, (v) => v.durationSeconds);
}

export function usePlayerPositionSeconds() {
  return useStore(PlayerStore, (v) => v.positionSeconds);
}
