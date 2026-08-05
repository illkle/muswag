import { isAbsolute } from "node:path";
import { createStore } from "@tanstack/react-store";

import type { MpvSource, MpvState } from "../../../shared/player";
import { createJsonFileStore } from "../support/json-file-store";
import { detectInstallOptions } from "./install-catalog";
import { collectMpvCandidates, createMpvLocatorDeps, type MpvLocatorDeps } from "./mpv-locator";
import { validateMpvBinary } from "./mpv-validator";

export type MpvPathState = { cachedPath: string | null; manualPath: string | null };

export function parseMpvPathState(value: unknown): MpvPathState {
  if (!value || typeof value !== "object") return { cachedPath: null, manualPath: null };
  const state = value as Partial<Record<keyof MpvPathState, unknown>>;
  return { cachedPath: parsePath(state.cachedPath), manualPath: parsePath(state.manualPath) };
}

export class MpvBinaryManager {
  readonly store = createStore<MpvState>({ status: "checking" });

  private readonly deps: MpvLocatorDeps;
  private readonly persistence;
  private pathState: MpvPathState;
  private pending: Promise<MpvState> | undefined;
  private resolvedBinaryPath: string | null = null;

  constructor(options: { statePath: string }, deps: Partial<MpvLocatorDeps> = {}) {
    this.deps = createMpvLocatorDeps(deps);
    this.persistence = createJsonFileStore(options.statePath, parseMpvPathState);
    this.pathState = this.persistence.load();
  }

  get binaryPath(): string | null {
    return this.resolvedBinaryPath;
  }

  refresh(): Promise<MpvState> {
    if (this.pending) return this.pending;
    this.store.setState(() => ({ status: "checking" }));
    this.pending = this.resolve()
      .catch((cause): MpvState => {
        console.error("[player][mpv] binary resolution failed", cause);
        return { checkedPaths: [], installOptions: [], status: "missing" };
      })
      .then((state) => {
        this.publish(state);
        return state;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  setManualPath(binaryPath: string): Promise<MpvState> {
    this.updatePathState({ cachedPath: null, manualPath: binaryPath });
    return this.refresh();
  }

  clearManualPath(): Promise<MpvState> {
    this.updatePathState({ cachedPath: null, manualPath: null });
    return this.refresh();
  }

  invalidate(): Promise<MpvState> {
    this.updatePathState({ cachedPath: null });
    return this.refresh();
  }

  private async resolve(): Promise<MpvState> {
    const checkedPaths: string[] = [];
    let firstInvalid: { binaryPath: string; reason: string; source: MpvSource } | undefined;
    const candidates = await collectMpvCandidates(this.pathState, this.deps);

    for (const candidate of candidates) {
      if (checkedPaths.includes(candidate.binaryPath)) continue;
      checkedPaths.push(candidate.binaryPath);
      const validation = await validateMpvBinary(candidate.binaryPath, this.deps);
      if (validation.ok) {
        return { binaryPath: candidate.binaryPath, source: candidate.source, status: "ready", version: validation.version };
      }

      if (candidate.explicit) {
        return {
          binaryPath: candidate.binaryPath,
          installOptions: await this.installOptions(),
          reason: validation.reason,
          source: candidate.source,
          status: "invalid",
        };
      }
      if (candidate.source !== "cache" && !validation.missing) {
        firstInvalid ??= { binaryPath: candidate.binaryPath, reason: validation.reason, source: candidate.source };
      }
    }

    const installOptions = await this.installOptions();
    return firstInvalid ? { ...firstInvalid, installOptions, status: "invalid" } : { checkedPaths, installOptions, status: "missing" };
  }

  private async installOptions() {
    try {
      return await detectInstallOptions(this.deps);
    } catch (cause) {
      console.error("[player][mpv] install option detection failed", cause);
      return [];
    }
  }

  private publish(state: MpvState): void {
    this.resolvedBinaryPath = state.status === "ready" ? state.binaryPath : null;
    this.updatePathState({ cachedPath: state.status === "ready" && isAbsolute(state.binaryPath) ? state.binaryPath : null });
    this.store.setState(() => state);
  }

  private updatePathState(patch: Partial<MpvPathState>): void {
    const next = parseMpvPathState({ ...this.pathState, ...patch });
    if (next.cachedPath === this.pathState.cachedPath && next.manualPath === this.pathState.manualPath) return;
    this.pathState = next;
    try {
      this.persistence.save(next);
    } catch (cause) {
      console.error("[player][mpv] path persistence failed", cause);
    }
  }
}

function parsePath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
