import { replaceEqualDeep } from "@tanstack/react-query";
import { createStore, type Store } from "@tanstack/react-store";

import { APP_CONNECT_CHANNEL } from "#shared/ipc";
import type { AppStateName, AppStateSnapshot, AppStateUpdate, AppStateValues } from "#shared/state/app-state";

type AppStateStores = { readonly [K in AppStateName]: Store<AppStateValues[K] | undefined> };

/**
 * Main's state as main publishes it (`shared/state/app-state.ts`), a store for each value: `undefined`
 * until main has published it. Read them through the hooks of each part of the app; change them only
 * through main's commands.
 */
export const appState: AppStateStores = {
  player: createStore<AppStateValues["player"] | undefined>(undefined),
  playerPosition: createStore<AppStateValues["playerPosition"] | undefined>(undefined),
  auth: createStore<AppStateValues["auth"] | undefined>(undefined),
  librarySync: createStore<AppStateValues["librarySync"] | undefined>(undefined),
  syncSettings: createStore<AppStateValues["syncSettings"] | undefined>(undefined),
  playlistSync: createStore<AppStateValues["playlistSync"] | undefined>(undefined),
  appUpdate: createStore<AppStateValues["appUpdate"] | undefined>(undefined),
  unplayable: createStore<AppStateValues["unplayable"] | undefined>(undefined),
  queue: createStore<AppStateValues["queue"] | undefined>(undefined),
};

/** The version of each value in its store. An update older than it, which the dev bridge can deliver late, is dropped. */
const versions = new Map<AppStateName, number>();
/** The highest version heard of: every change up to it has arrived. */
let seen = 0;
const waiters = new Set<{ readonly version: number; readonly resolve: () => void }>();

function apply<K extends AppStateName>(name: K, version: number, value: AppStateValues[K]): void {
  if ((versions.get(name) ?? -1) >= version) return;
  versions.set(name, version);
  // Main sends a value whole; what has not changed in it keeps its identity, so what draws it, such as the rows of the queue, is not drawn again.
  (appState[name] as Store<AppStateValues[K] | undefined>).setState((previous) => replaceEqualDeep(previous, value));
}

function reach(version: number): void {
  if (version <= seen) return;
  seen = version;
  for (const waiter of waiters) {
    if (waiter.version > seen) continue;
    waiters.delete(waiter);
    waiter.resolve();
  }
}

let connecting: Promise<void> | undefined;

/**
 * Connects to main: from then on main sends this window its state as it changes, and the changes to
 * the library. Resolves once the state as of connecting has arrived. Called once, before anything reads.
 */
export function connectToMain(): Promise<void> {
  connecting ??= (async () => {
    // Listening before connecting, so nothing sent after the state is read is missed.
    window.electron.ipcRenderer.on("app:state", (_event, payload) => {
      const update = payload as AppStateUpdate;
      apply(update.name, update.version, update.value);
      reach(update.version);
    });
    const { version, values } = (await window.electron.ipcRenderer.invoke(APP_CONNECT_CHANNEL)) as AppStateSnapshot;
    for (const name of Object.keys(appState) as AppStateName[]) {
      if (values[name] !== undefined) apply(name, version, values[name]);
    }
    reach(version);
  })();
  return connecting;
}

/** Resolves once every change up to `version` of main's state has arrived, or after `timeoutMs` regardless. */
export function untilAppStateVersion(version: number, timeoutMs: number): Promise<void> {
  if (version <= seen) return Promise.resolve();
  return new Promise((resolve) => {
    const waiter = {
      version,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      resolve();
    }, timeoutMs);
    waiters.add(waiter);
  });
}
