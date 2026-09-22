import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import type { CommandResult } from "../support/exec";
import { collectMpvCandidates, getWellKnownMpvPaths, type MpvLocatorDeps } from "./mpv-locator";
import { makeBinaries } from "./binaries";
import { validateMpvBinary } from "./mpv-validator";

function result(patch: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, errorCode: null, stderr: "", stdout: "", ...patch };
}

function deps(overrides: Partial<MpvLocatorDeps> = {}): MpvLocatorDeps {
  return {
    env: {},
    fileExists: () => Effect.succeed(false),
    homeDirectory: "/home/test",
    platform: "linux",
    runCommand: () => Effect.succeed(result({ code: 1 })),
    ...overrides,
  };
}

describe("mpv discovery and validation", () => {
  it("checks WinGet's command alias and installed-app paths on Windows", () => {
    const paths = getWellKnownMpvPaths(
      deps({
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "D:\\Programs", USERPROFILE: "C:\\Users\\me" },
        platform: "win32",
      }),
    );

    expect(paths).toContain("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\mpv.exe");
    expect(paths).toContain("D:\\Programs\\MPV Player\\mpv.exe");
  });

  it.effect("collects explicit, cached, PATH, well-known, then login-shell candidates", () =>
    Effect.gen(function* () {
      const candidates = yield* collectMpvCandidates(
        { cachedPath: " /cached ", manualPath: "/manual" },
        deps({
          env: { MUSWAG_MPV_PATH: "/env", SHELL: "/bin/zsh" },
          fileExists: (path) => Effect.succeed(path === "/usr/bin/mpv"),
          runCommand: () => Effect.succeed(result({ stdout: "banner\n/login/mpv\n" })),
        }),
      );
      expect(candidates).toEqual([
        { binaryPath: "/env", explicit: true, source: "env" },
        { binaryPath: "/manual", explicit: true, source: "manual" },
        { binaryPath: "/cached", explicit: false, source: "cache" },
        { binaryPath: "mpv", explicit: false, source: "path" },
        { binaryPath: "/usr/bin/mpv", explicit: false, source: "well-known" },
        { binaryPath: "/login/mpv", explicit: false, source: "login-shell" },
      ]);
    }),
  );

  it.effect("interprets versions and spawn errors", () =>
    Effect.gen(function* () {
      const validate = (patch: Partial<CommandResult>) => validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result(patch)) }));
      expect(yield* validate({ stdout: "mpv v0.41.0 Copyright" })).toEqual({ ok: true, version: "0.41.0" });
      expect(yield* validate({ stdout: "mpv 0.41.0-449-g1234567" })).toEqual({ ok: true, version: "0.41.0-449-g1234567" });
      expect(yield* validate({ stdout: "mpv 0.40.0" })).toMatchObject({ missing: false, ok: false, reason: expect.stringContaining("0.41.0") });
      expect(yield* validate({ stdout: "not mpv" })).toMatchObject({ missing: false, ok: false, reason: expect.stringContaining("could not be parsed") });
      expect(yield* validate({ code: null, errorCode: "EACCES" })).toEqual({ missing: false, ok: false, reason: "The file is not executable." });
    }),
  );
});

describe("binary service", () => {
  it.effect("does not bypass a broken explicit path but ignores a stale cache", () =>
    Effect.gen(function* () {
      const service = makeBinaries(deps({ runCommand: (command) => Effect.succeed(command === "mpv" ? result({ stdout: "mpv 0.41.0" }) : result({ code: null, errorCode: "ENOENT" })) }));
      expect(yield* service.resolve("/broken", null)).toMatchObject({ _tag: "Unavailable", reason: "invalid" });
      expect(yield* service.resolve(null, "/broken")).toMatchObject({ _tag: "Ready", path: "mpv" });
    }),
  );
});
