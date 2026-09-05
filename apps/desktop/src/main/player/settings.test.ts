import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "vitest";
import { defaultSettings, SettingsLive, SettingsStore } from "./settings";
import { Layer } from "effect";

describe("settings persistence", () => {
  it("defaults only missing files, rejects corruption and writes valid JSON atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "muswag-settings-"));
    const file = join(root, "settings.json");
    const layer = SettingsLive(file).pipe(Layer.provide([NodeFileSystem.layer, NodePath.layer]));
    try {
      const run = <A, E>(effect: Effect.Effect<A, E, SettingsStore>) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
      expect(await run(SettingsStore.use((store) => store.load))).toEqual(defaultSettings);
      await writeFile(file, "broken");
      expect((await run(SettingsStore.use((store) => store.load).pipe(Effect.result)))._tag).toBe("Failure");
      await run(SettingsStore.use((store) => store.save({ ...defaultSettings, volumePercent: 42 })));
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...defaultSettings, volumePercent: 42 });
      expect(await readdir(root)).toEqual(["settings.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
