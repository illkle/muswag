import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

import { Schema } from "effect";

import { DEFAULT_SYNC_SETTINGS, SyncSettings } from "#shared/state/sync-settings";
import type { AppStateHub } from "./app-state";

/** The sync settings, as kept in a file and shown to renderers. */
export interface SyncSettingsStore {
  readonly get: () => SyncSettings;
  readonly set: (settings: SyncSettings) => Promise<void>;
}

/** The settings saved in `path`, or the defaults when there are none or they cannot be read. */
function load(path: string): SyncSettings {
  try {
    return Schema.decodeSync(Schema.fromJsonString(SyncSettings))(readFileSync(path, "utf8"));
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
}

/** Keeps the sync settings in `path` and shows them to renderers through `state`. */
export function publishSyncSettings(state: AppStateHub, path: string): SyncSettingsStore {
  let settings = load(path);
  state.set("syncSettings", settings);
  // One write after another, so the file ends with the last setting asked for, as a field typed into asks for several.
  let writes = Promise.resolve();
  const save = async (next: SyncSettings) => {
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(next)}\n`);
    await rename(temp, path);
    settings = next;
    state.set("syncSettings", settings);
  };
  return {
    get: () => settings,
    set: (next) => {
      const written = writes.then(() => save(next));
      writes = written.catch(() => {});
      return written;
    },
  };
}
