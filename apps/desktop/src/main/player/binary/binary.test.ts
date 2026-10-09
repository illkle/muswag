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

  it.effect("collects explicit, cached, PATH, then well-known candidates, without running anything", () =>
    Effect.gen(function* () {
      let ran = 0;
      const candidates = yield* collectMpvCandidates(
        { cachedPath: " /cached ", manualPath: "/manual" },
        deps({
          env: { MUSWAG_MPV_PATH: "/env", SHELL: "/bin/zsh" },
          fileExists: (path) => Effect.succeed(path === "/usr/bin/mpv"),
          runCommand: () => Effect.sync(() => (ran++, result({ stdout: "banner\n/login/mpv\n" }))),
        }),
      );
      expect(candidates).toEqual([
        { binaryPath: "/env", explicit: true, source: "env" },
        { binaryPath: "/manual", explicit: true, source: "manual" },
        { binaryPath: "/cached", explicit: false, source: "cache" },
        { binaryPath: "mpv", explicit: false, source: "path" },
        { binaryPath: "/usr/bin/mpv", explicit: false, source: "well-known" },
      ]);
      expect(ran).toBe(0);
    }),
  );

  it("leaves the Flatpak and snap wrappers out on Linux", () => {
    expect(getWellKnownMpvPaths(deps()).filter((path) => /snap|flatpak/.test(path))).toEqual([]);
  });

  it.effect("interprets versions and spawn errors", () =>
    Effect.gen(function* () {
      const validate = (patch: Partial<CommandResult>) => validateMpvBinary("mpv", deps({ runCommand: () => Effect.succeed(result(patch)) }));
      expect(yield* validate({ stdout: "mpv v0.41.0 Copyright" })).toEqual({ ok: true, version: "0.41.0" });
      expect(yield* validate({ stdout: "mpv 0.41.0-449-g1234567" })).toEqual({ ok: true, version: "0.41.0-449-g1234567" });
      // What Debian 13 and Fedora ship is new enough; what came before `loadfile ... insert-at` is not.
      expect(yield* validate({ stdout: "mpv 0.40.0" })).toEqual({ ok: true, version: "0.40.0" });
      expect(yield* validate({ stdout: "mpv 0.38.0" })).toEqual({ ok: true, version: "0.38.0" });
      expect(yield* validate({ stdout: "mpv 0.37.0" })).toEqual({ missing: false, ok: false, reason: "mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer." });
      expect(yield* validate({ code: 1, stderr: "\ndyld: Library not loaded\n" })).toMatchObject({ ok: false, reason: "`--version` exited with code 1: dyld: Library not loaded" });
      expect(yield* validate({ stdout: "not mpv" })).toMatchObject({ missing: false, ok: false, reason: expect.stringContaining("could not be parsed") });
      expect(yield* validate({ code: null, errorCode: "EACCES" })).toEqual({ missing: false, ok: false, reason: "The file is not executable." });
    }),
  );
});

describe("binary service", () => {
  /** An environment where `versions` says what each binary answers to `--version`, and a login shell finds `/login/mpv`. */
  const environment = (versions: Record<string, string>, existing: readonly string[] = []) => {
    const ran: string[] = [];
    const service = makeBinaries(
      deps({
        env: { SHELL: "/bin/zsh" },
        fileExists: (path) => Effect.succeed(existing.includes(path)),
        runCommand: (command, args) =>
          Effect.sync(() => {
            ran.push(command);
            if (args[0] === "-ilc") return result({ stdout: "/login/mpv\n" });
            const version = versions[command];
            return version ? result({ stdout: `mpv ${version}` }) : result({ code: null, errorCode: "ENOENT" });
          }),
      }),
    );
    return { service, ran };
  };

  it.effect("does not bypass a broken explicit path but ignores a stale cache", () =>
    Effect.gen(function* () {
      const { service } = environment({ mpv: "0.41.0" });
      expect(yield* service.resolve("/broken", null)).toMatchObject({ _tag: "Unavailable", message: "The mpv you selected (/broken) cannot be used. The file does not exist." });
      expect(yield* service.resolve(null, "/broken")).toMatchObject({ _tag: "Ready", path: "mpv" });
    }),
  );

  it.effect("checks one binary when mpv is where it was last time, and asks a login shell only when nothing else runs", () =>
    Effect.gen(function* () {
      const remembered = environment({ "/cached": "0.41.0", mpv: "0.41.0", "/login/mpv": "0.41.0" });
      expect(yield* remembered.service.resolve(null, "/cached")).toMatchObject({ _tag: "Ready", path: "/cached", source: "cache" });
      expect(remembered.ran).toEqual(["/cached"]);

      const onPath = environment({ mpv: "0.41.0", "/login/mpv": "0.41.0" });
      expect(yield* onPath.service.resolve(null, null)).toMatchObject({ _tag: "Ready", path: "mpv", source: "path" });
      expect(onPath.ran).not.toContain("/bin/zsh");

      const shellOnly = environment({ "/login/mpv": "0.41.0" });
      expect(yield* shellOnly.service.resolve(null, null)).toMatchObject({ _tag: "Ready", path: "/login/mpv", source: "login-shell" });
      expect(shellOnly.ran).toEqual(["mpv", "/bin/zsh", "/login/mpv"]);
    }),
  );

  it.effect("says which binary it found and why that one cannot be used", () =>
    Effect.gen(function* () {
      const old = environment({ mpv: "0.37.0", "/usr/bin/mpv": "0.37.0" }, ["/usr/bin/mpv"]);
      // Nobody configured this binary: the app found it, and says where.
      expect(yield* old.service.resolve(null, null)).toMatchObject({
        _tag: "Unavailable",
        message: "The mpv on PATH cannot be used. mpv 0.37.0 is too old. Muswag requires mpv 0.38.0 or newer.",
      });

      const none = environment({});
      expect(yield* none.service.resolve(null, null)).toMatchObject({ _tag: "Unavailable", message: "mpv was not found. Install it, or select its executable." });
    }),
  );
});
