import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdateState } from "#shared/state/app-update";

const electron = vi.hoisted(() => ({ version: "1.2.3" }));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => electron.version,
  },
}));

/** electron-updater's updater as far as the app uses it; setting `channel` allows downgrades, as there. */
const updater = vi.hoisted(() => {
  const value = {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    _channel: null as string | null,
    get channel() {
      return value._channel;
    },
    set channel(channel: string | null) {
      value._channel = channel;
      value.allowDowngrade = true;
    },
    checkForUpdates: vi.fn(async () => null),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
  };
  return value;
});

vi.mock("electron-updater", () => ({ default: { autoUpdater: updater } }));

/** Loads the module afresh, as each run of the app does, and publishes to a stand-in for the mirror. */
async function start(settingsPath: string) {
  vi.resetModules();
  const { appUpdates, initializeAutoUpdater, publishAppUpdates } = await import("./app-updater");
  const published: AppUpdateState[] = [];
  const state = { upsert: (_table: unknown, row: { value: AppUpdateState }) => Effect.sync(() => void published.push(row.value)) };
  publishAppUpdates(state as never, settingsPath);
  return {
    initializeAutoUpdater,
    latest: () => published.at(-1)!,
    setChannel: appUpdates.setChannel,
  };
}

describe("app updater channels", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muswag-updater-"));
    settingsPath = join(dir, "update-settings.json");
    electron.version = "1.2.3";
    Object.assign(updater, { allowDowngrade: false, allowPrerelease: false, _channel: null });
    updater.checkForUpdates.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts on the channel the installed version came from", async () => {
    expect((await start(settingsPath)).latest().channel).toBe("stable");

    electron.version = "1.2.4-nightly.20261025.7";
    const nightly = await start(settingsPath);
    expect(nightly.latest().channel).toBe("nightly");

    nightly.initializeAutoUpdater();
    expect(updater).toMatchObject({ allowPrerelease: true, channel: "nightly", allowDowngrade: false });
  });

  it("keeps a chosen channel, and points the updater at it without allowing downgrades", async () => {
    const first = await start(settingsPath);
    first.initializeAutoUpdater();
    expect(updater).toMatchObject({ allowPrerelease: false, channel: "latest", allowDowngrade: false });

    await first.setChannel("nightly");
    expect(first.latest().channel).toBe("nightly");
    expect(updater).toMatchObject({ allowPrerelease: true, channel: "nightly", allowDowngrade: false });
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ channel: "nightly" });

    const next = await start(settingsPath);
    expect(next.latest().channel).toBe("nightly");
  });

  it("starts over from a file it cannot read", async () => {
    await writeFile(settingsPath, "{ not json");
    expect((await start(settingsPath)).latest().channel).toBe("stable");
  });
});
