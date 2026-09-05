import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { CommandResult } from "../support/exec";
import { collectMpvCandidates, getWellKnownMpvPaths, type MpvLocatorDeps } from "./mpv-locator";
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

  it("collects explicit, cached, PATH, well-known, then login-shell candidates", async () => {
    const candidates = await Effect.runPromise(
      collectMpvCandidates(
        { cachedPath: " /cached ", manualPath: "/manual" },
        deps({
          env: { MUSWAG_MPV_PATH: "/env", SHELL: "/bin/zsh" },
          fileExists: (path) => Effect.succeed(path === "/usr/bin/mpv"),
          runCommand: () => Effect.succeed(result({ stdout: "banner\n/login/mpv\n" })),
        }),
      ),
    );
    expect(candidates).toEqual([
      { binaryPath: "/env", explicit: true, source: "env" },
      { binaryPath: "/manual", explicit: true, source: "manual" },
      { binaryPath: "/cached", explicit: false, source: "cache" },
      { binaryPath: "mpv", explicit: false, source: "path" },
      { binaryPath: "/usr/bin/mpv", explicit: false, source: "well-known" },
      { binaryPath: "/login/mpv", explicit: false, source: "login-shell" },
    ]);
  });

  it("interprets versions and spawn errors", async () => {
    await expect(Effect.runPromise(validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result({ stdout: "mpv v0.41.0 Copyright" })) })))).resolves.toEqual({
      ok: true,
      version: "0.41.0",
    });
    await expect(Effect.runPromise(validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result({ stdout: "mpv 0.41.0-449-g1234567" })) })))).resolves.toEqual({
      ok: true,
      version: "0.41.0-449-g1234567",
    });
    await expect(Effect.runPromise(validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result({ stdout: "mpv 0.40.0" })) })))).resolves.toMatchObject({
      missing: false,
      ok: false,
      reason: expect.stringContaining("0.41.0"),
    });
    await expect(Effect.runPromise(validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result({ stdout: "not mpv" })) })))).resolves.toMatchObject({
      missing: false,
      ok: false,
      reason: expect.stringContaining("could not be parsed"),
    });
    await expect(Effect.runPromise(validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result({ code: null, errorCode: "EACCES" })) })))).resolves.toEqual({
      missing: false,
      ok: false,
      reason: "The file is not executable.",
    });
  });
});

describe("binary service", () => {
  it("does not bypass a broken explicit path but ignores a stale cache", async () => {
    const { makeBinaries } = await import("./binaries");
    const service = makeBinaries(deps({ runCommand: (command) => Effect.succeed(command === "mpv" ? result({ stdout: "mpv 0.41.0" }) : result({ code: null, errorCode: "ENOENT" })) }));
    expect(await Effect.runPromise(service.resolve("/broken", null))).toMatchObject({ _tag: "Unavailable", reason: "invalid" });
    expect(await Effect.runPromise(service.resolve(null, "/broken"))).toMatchObject({ _tag: "Ready", path: "mpv" });
  });
});
