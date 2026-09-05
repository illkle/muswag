import { Effect } from "effect";
import { dirname } from "node:path";

import type { MpvInstallMethod, MpvInstallOption } from "#shared/player";
import type { MpvLocatorDeps } from "./mpv-locator";
import { joinWindowsPath, probeLoginShell } from "./mpv-locator";

const LOOKUP_TIMEOUT_MS = 3_000;

export type MpvInstallCandidate = { args: string[]; managerPath: string | null; option: MpvInstallOption };

export function detectInstallCandidates(deps: MpvLocatorDeps): Effect.Effect<MpvInstallCandidate[]> {
  return Effect.gen(function* () {
    if (deps.platform === "darwin") return yield* detectMac(deps);
    if (deps.platform === "win32") return yield* detectWindows(deps);
    return yield* detectLinux(deps);
  });
}

export function detectInstallOptions(deps: MpvLocatorDeps): Effect.Effect<MpvInstallOption[]> {
  return Effect.gen(function* () {
    return (yield* detectInstallCandidates(deps)).map(({ option }) => option);
  });
}

export function getManagerBinDirectory(managerPath: string): string {
  return dirname(managerPath);
}

function findManager(name: string, known: string[], deps: MpvLocatorDeps): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    for (const path of known) if (yield* deps.fileExists(path)) return path;
    const result = yield* deps.runCommand(deps.platform === "win32" ? "where" : "which", [name], {
      env: deps.env,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    if (!result.errorCode && result.code === 0) {
      const path = result.stdout
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
      if (path) return path;
    }
    return yield* probeLoginShell(name, deps);
  });
}

function detectMac(deps: MpvLocatorDeps): Effect.Effect<MpvInstallCandidate[]> {
  return Effect.gen(function* () {
    const managerPath = yield* findManager("brew", ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"], deps);
    return [
      {
        args: ["install", "mpv"],
        managerPath,
        option: {
          automatic: managerPath !== null,
          command: "brew install mpv",
          method: "brew",
          note: managerPath ? null : "Homebrew is not installed. Install Homebrew first, then run this command in a terminal.",
          url: managerPath ? null : "https://brew.sh",
        },
      },
    ];
  });
}

function detectWindows(deps: MpvLocatorDeps): Effect.Effect<MpvInstallCandidate[]> {
  return Effect.gen(function* () {
    const candidates: MpvInstallCandidate[] = [];
    const profile = deps.env.USERPROFILE ?? deps.homeDirectory;
    const localAppData = deps.env.LOCALAPPDATA;
    const winget = yield* findManager("winget", localAppData ? [joinWindowsPath(localAppData, "Microsoft\\WindowsApps\\winget.exe")] : [], deps);
    if (winget)
      candidates.push({
        args: ["install", "--id", "mpv-player.mpv-CI.MSVC", "--exact", "--source", "winget", "--scope", "user", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"],
        managerPath: winget,
        option: {
          automatic: true,
          command: "winget install --id mpv-player.mpv-CI.MSVC --exact --source winget --scope user",
          method: "winget",
          note: null,
          url: null,
        },
      });
    const scoop = yield* findManager("scoop", [joinWindowsPath(profile, "scoop\\shims\\scoop.cmd")], deps);
    if (scoop)
      candidates.push({
        args: ["install", "extras/mpv"],
        managerPath: scoop,
        option: { automatic: false, command: "scoop install extras/mpv", method: "scoop", note: "Run this in a terminal, then re-check.", url: null },
      });
    const choco = yield* findManager("choco", ["C:\\ProgramData\\chocolatey\\bin\\choco.exe"], deps);
    if (choco)
      candidates.push({
        args: ["install", "mpv", "-y"],
        managerPath: choco,
        option: { automatic: false, command: "choco install mpv", method: "choco", note: "Run this in an administrator terminal, then re-check.", url: null },
      });
    if (candidates.length === 0)
      candidates.push({
        args: ["install", "--id", "mpv-player.mpv-CI.MSVC", "--exact", "--source", "winget", "--scope", "user"],
        managerPath: null,
        option: {
          automatic: false,
          command: "winget install --id mpv-player.mpv-CI.MSVC --exact --source winget --scope user",
          method: "winget",
          note: "No supported package manager was found. Install WinGet first, or locate mpv.exe manually.",
          url: "https://learn.microsoft.com/windows/package-manager/winget/",
        },
      });
    return candidates;
  });
}

function detectLinux(deps: MpvLocatorDeps): Effect.Effect<MpvInstallCandidate[]> {
  return Effect.gen(function* () {
    const managers: Array<{ args: string[]; command: string; method: MpvInstallMethod; name: string; paths: string[] }> = [
      { args: ["install", "mpv"], command: "sudo apt install mpv", method: "apt", name: "apt", paths: ["/usr/bin/apt"] },
      { args: ["install", "mpv"], command: "sudo dnf install mpv", method: "dnf", name: "dnf", paths: ["/usr/bin/dnf"] },
      { args: ["-S", "mpv"], command: "sudo pacman -S mpv", method: "pacman", name: "pacman", paths: ["/usr/bin/pacman"] },
      { args: ["install", "mpv"], command: "sudo zypper install mpv", method: "zypper", name: "zypper", paths: ["/usr/bin/zypper"] },
      { args: ["install", "--user", "flathub", "io.mpv.Mpv"], command: "flatpak install --user flathub io.mpv.Mpv", method: "flatpak", name: "flatpak", paths: ["/usr/bin/flatpak"] },
    ];
    const candidates: MpvInstallCandidate[] = [];
    for (const manager of managers) {
      const managerPath = yield* findManager(manager.name, manager.paths, deps);
      if (managerPath)
        candidates.push({
          args: manager.args,
          managerPath,
          option: { automatic: false, command: manager.command, method: manager.method, note: "Run this in a terminal, then re-check.", url: null },
        });
    }
    return candidates;
  });
}
