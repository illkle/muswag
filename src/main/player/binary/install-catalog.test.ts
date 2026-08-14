import { describe, expect, it } from "vitest";
import type { CommandResult } from "../support/exec";
import { detectInstallCandidates } from "./install-catalog";
import type { MpvLocatorDeps } from "./mpv-locator";

const failed: CommandResult = { code: 1, errorCode: null, stderr: "", stdout: "" };

function deps(overrides: Partial<MpvLocatorDeps>): MpvLocatorDeps {
  return {
    env: {},
    fileExists: async () => false,
    homeDirectory: "/home/test",
    platform: "linux",
    runCommand: async () => failed,
    ...overrides,
  };
}

describe("install catalog", () => {
  it("offers automatic Homebrew only when brew is installed", async () => {
    const installed = await detectInstallCandidates(deps({ platform: "darwin", fileExists: async (path) => path === "/opt/homebrew/bin/brew" }));
    expect(installed[0]).toMatchObject({ managerPath: "/opt/homebrew/bin/brew", option: { automatic: true, method: "brew", url: null } });
    const missing = await detectInstallCandidates(deps({ platform: "darwin" }));
    expect(missing[0]).toMatchObject({ managerPath: null, option: { automatic: false, method: "brew", url: "https://brew.sh" } });
  });

  it("lists only installed Linux managers and uses the Flathub app id", async () => {
    const candidates = await detectInstallCandidates(deps({ fileExists: async (path) => path === "/usr/bin/flatpak" }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ args: ["install", "--user", "flathub", "io.mpv.Mpv"], option: { automatic: false, method: "flatpak" } });
  });

  it("offers an automatic user-scoped WinGet install when WinGet is available", async () => {
    const candidates = await detectInstallCandidates(
      deps({
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
        fileExists: async (path) => path === "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
        platform: "win32",
      }),
    );

    expect(candidates[0]).toMatchObject({
      args: ["install", "--id", "mpv-player.mpv-CI.MSVC", "--exact", "--source", "winget", "--scope", "user", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
      managerPath: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
      option: { automatic: true, method: "winget", url: null },
    });
  });

  it("falls back to WinGet instructions when Windows has no manager", async () => {
    const candidates = await detectInstallCandidates(deps({ env: { USERPROFILE: "C:\\Users\\me" }, platform: "win32" }));
    expect(candidates).toEqual([
      expect.objectContaining({
        managerPath: null,
        option: expect.objectContaining({ method: "winget", url: "https://learn.microsoft.com/windows/package-manager/winget/" }),
      }),
    ]);
  });
});
