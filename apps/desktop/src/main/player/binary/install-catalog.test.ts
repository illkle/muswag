import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import type { CommandResult } from "../support/exec";
import { detectInstallCandidates } from "./install-catalog";
import type { MpvLocatorDeps } from "./mpv-locator";

const failed: CommandResult = { code: 1, errorCode: null, stderr: "", stdout: "" };

function deps(overrides: Partial<MpvLocatorDeps>): MpvLocatorDeps {
  return {
    env: {},
    fileExists: () => Effect.succeed(false),
    homeDirectory: "/home/test",
    platform: "linux",
    runCommand: () => Effect.succeed(failed),
    ...overrides,
  };
}

describe("install catalog", () => {
  it.effect("offers automatic Homebrew only when brew is installed", () =>
    Effect.gen(function* () {
      const installed = yield* detectInstallCandidates(deps({ platform: "darwin", fileExists: (path) => Effect.succeed(path === "/opt/homebrew/bin/brew") }));
      expect(installed[0]).toMatchObject({ managerPath: "/opt/homebrew/bin/brew", option: { automatic: true, method: "brew", url: null } });
      const missing = yield* detectInstallCandidates(deps({ platform: "darwin" }));
      expect(missing[0]).toMatchObject({ managerPath: null, option: { automatic: false, method: "brew", url: "https://brew.sh" } });
    }),
  );

  it.effect("lists only installed Linux managers and uses the Flathub app id", () =>
    Effect.gen(function* () {
      const candidates = yield* detectInstallCandidates(deps({ fileExists: (path) => Effect.succeed(path === "/usr/bin/flatpak") }));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ args: ["install", "--user", "flathub", "io.mpv.Mpv"], option: { automatic: false, method: "flatpak" } });
    }),
  );

  it.effect("offers an automatic user-scoped WinGet install when WinGet is available", () =>
    Effect.gen(function* () {
      const candidates = yield* detectInstallCandidates(
        deps({
          env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
          fileExists: (path) => Effect.succeed(path === "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe"),
          platform: "win32",
        }),
      );

      expect(candidates[0]).toMatchObject({
        args: ["install", "--id", "mpv-player.mpv-CI.MSVC", "--exact", "--source", "winget", "--scope", "user", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
        managerPath: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
        option: { automatic: true, method: "winget", url: null },
      });
    }),
  );

  it.effect("falls back to WinGet instructions when Windows has no manager", () =>
    Effect.gen(function* () {
      const candidates = yield* detectInstallCandidates(deps({ env: { USERPROFILE: "C:\\Users\\me" }, platform: "win32" }));
      expect(candidates).toEqual([
        expect.objectContaining({
          managerPath: null,
          option: expect.objectContaining({ method: "winget", url: "https://learn.microsoft.com/windows/package-manager/winget/" }),
        }),
      ]);
    }),
  );
});
