import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { defaultSettings, makeSettingsWriter, SettingsLive, SettingsStore, type Settings } from "./settings";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

describe("settings persistence", () => {
  it.effect("defaults only missing files, rejects corruption and writes valid JSON atomically", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem).makeTempDirectoryScoped({ prefix: "muswag-settings-" });
      const file = join(root, "settings.json");
      const store = yield* SettingsStore.use(Effect.succeed).pipe(Effect.provide(SettingsLive(file).pipe(Layer.provide(platform))));
      expect(yield* store.load).toEqual(defaultSettings);
      yield* Effect.promise(() => writeFile(file, "broken"));
      expect(yield* store.load.pipe(Effect.flip)).toMatchObject({ _tag: "SettingsError", operation: "load" });
      yield* store.save({ ...defaultSettings, volumePercent: 42 });
      expect(JSON.parse(yield* Effect.promise(() => readFile(file, "utf8")))).toEqual({ ...defaultSettings, volumePercent: 42 });
      expect(yield* Effect.promise(() => readdir(root))).toEqual(["settings.json"]);
    }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});

describe("settings writer", () => {
  it.effect("coalesces scheduled writes and flushes whatever is still pending", () =>
    Effect.gen(function* () {
      const saved: number[] = [];
      const store = { load: Effect.succeed(defaultSettings), save: (settings: Settings) => Effect.sync(() => void saved.push(settings.volumePercent)) };
      const writer = yield* makeSettingsWriter(store, Effect.void);
      yield* writer.schedule({ ...defaultSettings, volumePercent: 10 });
      yield* writer.schedule({ ...defaultSettings, volumePercent: 20 });
      yield* TestClock.adjust("250 millis");
      expect(saved).toEqual([20]);
      yield* writer.schedule({ ...defaultSettings, volumePercent: 30 });
      yield* writer.flush;
      yield* TestClock.adjust("1 second");
      expect(saved).toEqual([20, 30]);
    }).pipe(Effect.scoped),
  );
});
