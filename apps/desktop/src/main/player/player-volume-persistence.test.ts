import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadPlayerVolumeState, savePlayerVolumeState } from "./player-volume-persistence";

describe("PlayerVolumePersistence", () => {
  it("falls back to defaults when no persisted state exists", () => {
    expect(loadPlayerVolumeState(join(tmpdir(), "muswag-missing-volume.json"))).toEqual({
      muted: false,
      volumePercent: 100,
    });
  });

  it("loads and clamps persisted volume state", () => {
    const directory = mkdtempSync(join(tmpdir(), "muswag-volume-"));
    const filePath = join(directory, "player-volume.json");

    try {
      writeFileSync(filePath, JSON.stringify({ muted: true, volumePercent: 72.6 }), "utf8");

      expect(loadPlayerVolumeState(filePath)).toEqual({
        muted: true,
        volumePercent: 73,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("saves volume state", () => {
    const directory = mkdtempSync(join(tmpdir(), "muswag-volume-"));
    const filePath = join(directory, "nested/player-volume.json");

    try {
      savePlayerVolumeState(filePath, { muted: true, volumePercent: 25 });

      expect(loadPlayerVolumeState(filePath)).toEqual({
        muted: true,
        volumePercent: 25,
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
