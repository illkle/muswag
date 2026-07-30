import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDefaultMpvPathState, loadMpvPathState, saveMpvPathState } from "./mpv-path-persistence";

describe("MpvPathPersistence", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "muswag-mpv-path-"));
    filePath = join(directory, "nested", "mpv.json");
  });

  afterEach(() => {
    rmSync(directory, { force: true, recursive: true });
  });

  it("round-trips through a directory that does not exist yet", () => {
    saveMpvPathState(filePath, { cachedPath: "/opt/homebrew/bin/mpv", manualPath: null });

    expect(loadMpvPathState(filePath)).toEqual({ cachedPath: "/opt/homebrew/bin/mpv", manualPath: null });
  });

  it("returns defaults for a missing file", () => {
    expect(loadMpvPathState(filePath)).toEqual(createDefaultMpvPathState());
  });

  it("ignores malformed contents instead of throwing", () => {
    saveMpvPathState(filePath, createDefaultMpvPathState());
    writeFileSync(filePath, "{ not json", "utf8");

    expect(loadMpvPathState(filePath)).toEqual(createDefaultMpvPathState());
  });

  it("drops blank and non-string paths", () => {
    saveMpvPathState(filePath, createDefaultMpvPathState());
    writeFileSync(filePath, JSON.stringify({ cachedPath: "   ", manualPath: 42 }), "utf8");

    expect(loadMpvPathState(filePath)).toEqual({ cachedPath: null, manualPath: null });
  });
});
