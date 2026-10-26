import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppStateHub } from "./app-state";
import { publishSyncSettings } from "./sync-settings";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "muswag-sync-settings-"));
  path = join(dir, "sync-settings.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("publishSyncSettings", () => {
  it("starts with a week, keeps what is set across starts, and shows it to renderers", async () => {
    const state = new AppStateHub();
    const settings = publishSyncSettings(state, path);
    expect(settings.get()).toEqual({ syncAfter: { amount: 1, unit: "weeks" } });
    expect(state.snapshot().values.syncSettings).toEqual({ syncAfter: { amount: 1, unit: "weeks" } });

    await settings.set({ syncAfter: { amount: 12, unit: "hours" } });
    expect(settings.get()).toEqual({ syncAfter: { amount: 12, unit: "hours" } });
    expect(state.snapshot().values.syncSettings).toEqual({ syncAfter: { amount: 12, unit: "hours" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ syncAfter: { amount: 12, unit: "hours" } });

    expect(publishSyncSettings(new AppStateHub(), path).get()).toEqual({ syncAfter: { amount: 12, unit: "hours" } });
  });

  it("keeps the last of settings set one after another without waiting", async () => {
    const settings = publishSyncSettings(new AppStateHub(), path);
    await Promise.all([1, 12, 2].map((amount) => settings.set({ syncAfter: { amount, unit: "hours" } })));
    expect(settings.get()).toEqual({ syncAfter: { amount: 2, unit: "hours" } });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ syncAfter: { amount: 2, unit: "hours" } });
  });

  it("goes back to the defaults when the file holds something it does not take", async () => {
    for (const content of [
      "not json",
      JSON.stringify({ syncAfterHours: 168 }),
      JSON.stringify({ syncAfter: { amount: 4, unit: "minutes" } }),
      JSON.stringify({ syncAfter: { amount: 1.5, unit: "days" } }),
    ]) {
      await writeFile(path, content);
      expect(publishSyncSettings(new AppStateHub(), path).get()).toEqual({ syncAfter: { amount: 1, unit: "weeks" } });
    }
  });
});
