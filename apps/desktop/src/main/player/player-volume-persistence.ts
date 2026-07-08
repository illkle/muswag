import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PlayerVolumeState } from "../../shared/player";
import { createDefaultPlayerVolumeState } from "../../shared/player";

type PersistedPlayerVolumeState = Partial<PlayerVolumeState>;

export function loadPlayerVolumeState(filePath: string): PlayerVolumeState {
  try {
    return parsePlayerVolumeState(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return createDefaultPlayerVolumeState();
  }
}

export function savePlayerVolumeState(filePath: string, state: PlayerVolumeState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parsePlayerVolumeState(value: unknown): PlayerVolumeState {
  const fallback = createDefaultPlayerVolumeState();

  if (!value || typeof value !== "object") {
    return fallback;
  }

  const persistedState = value as PersistedPlayerVolumeState;
  const volumePercent =
    typeof persistedState.volumePercent === "number" && Number.isFinite(persistedState.volumePercent)
      ? Math.min(100, Math.max(0, Math.round(persistedState.volumePercent)))
      : fallback.volumePercent;

  return {
    muted: typeof persistedState.muted === "boolean" ? persistedState.muted : fallback.muted,
    volumePercent,
  };
}
