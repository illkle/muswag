import { Context } from "effect";

import type { AppStateName, AppStateSnapshot, AppStateUpdate, AppStateValues } from "#shared/state/app-state";

/**
 * Main's state as renderers see it (`shared/state/app-state.ts`): the latest value of each kind, and a
 * version that goes up by one with every change. Setting a value equal to the one there is no change.
 * Values are plain data, sent to renderers as they are.
 */
export class AppStateHub {
  private values: Partial<AppStateValues> = {};
  /** Each value as JSON, to tell an equal one from a change. */
  private readonly serialized = new Map<AppStateName, string>();
  private readonly listeners = new Set<(update: AppStateUpdate) => void>();
  private currentVersion = 0;

  /** The version of the state: how many changes it has had. */
  get version(): number {
    return this.currentVersion;
  }

  get<K extends AppStateName>(name: K): AppStateValues[K] | undefined {
    return this.values[name];
  }

  set<K extends AppStateName>(name: K, value: AppStateValues[K]): void {
    const json = JSON.stringify(value);
    if (this.serialized.get(name) === json) return;
    this.serialized.set(name, json);
    this.values = { ...this.values, [name]: value };
    const update = { version: ++this.currentVersion, name, value } as AppStateUpdate;
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(update);
      } catch (cause) {
        console.error("[app-state] a listener failed", cause);
      }
    }
  }

  snapshot(): AppStateSnapshot {
    return { version: this.currentVersion, values: this.values };
  }

  /** Calls `listener` with every change, until the returned function is called. */
  subscribe(listener: (update: AppStateUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The hub, for the parts of main built as Effect layers, such as the player. */
export class AppState extends Context.Service<AppState, AppStateHub>()("@muswag/desktop/AppState") {}
