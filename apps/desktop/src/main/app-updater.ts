import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";

import electronUpdater from "electron-updater";
import { app } from "electron";
import type { MemoryMirrorService } from "@muswag/tanstack-db-mirror/server/memory";
import { Effect, Schema } from "effect";

import { appUpdate, channelOfVersion, UpdateChannel, type AppUpdateState } from "#shared/state/app-update";
import type { AppUpdates } from "./app/commands";

const { autoUpdater } = electronUpdater;

let initialized = false;
let pendingCheck: Promise<void> | null = null;
/** Where the chosen channel is kept; set by `publishAppUpdates`. */
let settingsPath: string | null = null;
/** Shows renderers the state; set by `publishAppUpdates`. */
let publish: (state: AppUpdateState) => void = () => {};
let updateState: AppUpdateState = {
  canCheck: app.isPackaged,
  channel: channelOfVersion(app.getVersion()),
  currentVersion: app.getVersion(),
  error: null,
  latestVersion: null,
  lastCheckedAt: null,
  progressPercent: null,
  status: app.isPackaged ? "idle" : "disabled",
};

function setUpdateState(patch: Partial<AppUpdateState>): void {
  updateState = { ...updateState, ...patch };
  publish(updateState);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UpdateSettings = Schema.Struct({ channel: UpdateChannel });

/** The channel chosen in an earlier run, or null when none was. */
function loadChannel(settingsPath: string): UpdateChannel | null {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(UpdateSettings))(readFileSync(settingsPath, "utf8")).channel;
  } catch {
    return null;
  }
}

async function saveChannel(settingsPath: string, channel: UpdateChannel): Promise<void> {
  const temp = `${settingsPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ channel })}\n`);
  await rename(temp, settingsPath);
}

/**
 * Points the updater at a channel's releases. Stable ones are what GitHub marks as the latest
 * release, with `latest*.yml`; nightly ones are prereleases with `nightly*.yml`.
 */
function applyChannel(channel: UpdateChannel): void {
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
  // Setting the channel allows going back to an older version. A nightly install that moves to stable
  // stays where it is until a stable release is newer, since an older build may not open a library
  // that a newer one has migrated.
  autoUpdater.allowDowngrade = false;
}

function checkForAppUpdates(): Promise<void> {
  if (!app.isPackaged) {
    return Promise.resolve();
  }

  if (pendingCheck) {
    return pendingCheck;
  }

  setUpdateState({
    error: null,
    lastCheckedAt: new Date().toISOString(),
    progressPercent: null,
    status: "checking",
  });

  pendingCheck = autoUpdater
    .checkForUpdates()
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error("Muswag auto-update check failed", error);
      setUpdateState({ error: getErrorMessage(error), status: "error" });
    })
    .finally(() => {
      pendingCheck = null;
    });

  return pendingCheck;
}

function installAppUpdate(): void {
  if (updateState.status !== "ready") {
    return;
  }

  autoUpdater.quitAndInstall();
}

export function initializeAutoUpdater(): void {
  if (initialized || !app.isPackaged) {
    return;
  }

  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  applyChannel(updateState.channel);

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ error: null, progressPercent: null, status: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({ latestVersion: info.version, status: "downloading" });
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({ latestVersion: info.version, progressPercent: null, status: "up-to-date" });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({ progressPercent: Math.round(progress.percent), status: "downloading" });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({ latestVersion: info.version, progressPercent: 100, status: "ready" });
  });

  autoUpdater.on("error", (error) => {
    console.error("Muswag auto-update failed", error);
    setUpdateState({ error: getErrorMessage(error), status: "error" });
  });

  void checkForAppUpdates();
}

/** Updates from `channel` from now on, and checks it. */
async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  if (channel === updateState.channel) return;
  if (settingsPath) await saveChannel(settingsPath, channel);
  setUpdateState({ channel, latestVersion: null });
  if (!initialized) return;
  applyChannel(channel);
  // A check that is under way asks the old channel; the new one is asked after it.
  await (pendingCheck ?? Promise.resolve()).then(checkForAppUpdates);
}

/** What renderers ask of the updater through `app:command`. */
export const appUpdates: AppUpdates = { check: checkForAppUpdates, install: installAppUpdate, setChannel: setUpdateChannel };

/**
 * Shows renderers the update state in `state`, which must mirror `appUpdate`, and keeps the chosen
 * channel in `channelPath`.
 */
export function publishAppUpdates(state: MemoryMirrorService, channelPath: string): void {
  settingsPath = channelPath;
  updateState = { ...updateState, channel: loadChannel(channelPath) ?? updateState.channel };
  publish = (value) => void Effect.runFork(state.upsert(appUpdate, { id: "app_update", value }));
  publish(updateState);
}
