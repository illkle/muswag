import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type MpvPathState = {
  /** Last binary path that resolved successfully, used as a fast path on the next launch. */
  cachedPath: string | null;
  /** Path the user picked by hand. Treated as authoritative and reported when it breaks. */
  manualPath: string | null;
};

type PersistedMpvPathState = Partial<Record<keyof MpvPathState, unknown>>;

export function createDefaultMpvPathState(): MpvPathState {
  return { cachedPath: null, manualPath: null };
}

export function loadMpvPathState(filePath: string): MpvPathState {
  try {
    return parseMpvPathState(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return createDefaultMpvPathState();
  }
}

export function saveMpvPathState(filePath: string, state: MpvPathState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseMpvPathState(value: unknown): MpvPathState {
  if (!value || typeof value !== "object") {
    return createDefaultMpvPathState();
  }

  const persistedState = value as PersistedMpvPathState;

  return {
    cachedPath: parsePath(persistedState.cachedPath),
    manualPath: parsePath(persistedState.manualPath),
  };
}

function parsePath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
