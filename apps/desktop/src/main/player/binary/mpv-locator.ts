import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MpvSource } from "../../../shared/player";
import { runCommand } from "../support/exec";

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 3_000;

export type MpvLocatorDeps = {
  env: Record<string, string | undefined>;
  fileExists: (filePath: string) => Promise<boolean>;
  homeDirectory: string;
  platform: NodeJS.Platform;
  runCommand: typeof runCommand;
};

export type MpvCandidate = { binaryPath: string; source: MpvSource; explicit: boolean };

export function createMpvLocatorDeps(overrides: Partial<MpvLocatorDeps> = {}): MpvLocatorDeps {
  return {
    env: process.env,
    fileExists: async (filePath) => {
      try {
        await access(filePath, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    homeDirectory: homedir(),
    platform: process.platform,
    runCommand,
    ...overrides,
  };
}

export async function collectMpvCandidates(options: { manualPath?: string | null; cachedPath?: string | null }, deps: MpvLocatorDeps): Promise<MpvCandidate[]> {
  const candidates: MpvCandidate[] = [];
  addPath(candidates, deps.env.MUSWAG_MPV_PATH, "env", true);
  addPath(candidates, options.manualPath, "manual", true);
  addPath(candidates, options.cachedPath, "cache", false);
  candidates.push({ binaryPath: deps.platform === "win32" ? "mpv.exe" : "mpv", explicit: false, source: "path" });

  for (const binaryPath of getWellKnownMpvPaths(deps)) {
    if (await deps.fileExists(binaryPath)) {
      candidates.push({ binaryPath, explicit: false, source: "well-known" });
    }
  }

  const shellPath = await probeLoginShell("mpv", deps);
  if (shellPath) candidates.push({ binaryPath: shellPath, explicit: false, source: "login-shell" });
  return candidates;
}

export function getWellKnownMpvPaths(deps: MpvLocatorDeps): string[] {
  if (deps.platform === "darwin") {
    return ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/opt/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv", join(deps.homeDirectory, "Applications/mpv.app/Contents/MacOS/mpv")];
  }
  if (deps.platform === "win32") {
    const userProfile = deps.env.USERPROFILE ?? deps.homeDirectory;
    const programFiles = deps.env.ProgramFiles ?? "C:\\Program Files";
    return [
      ...(deps.env.LOCALAPPDATA ? [joinWindowsPath(deps.env.LOCALAPPDATA, "Microsoft\\WinGet\\Links\\mpv.exe")] : []),
      joinWindowsPath(userProfile, "scoop\\shims\\mpv.exe"),
      "C:\\ProgramData\\chocolatey\\bin\\mpv.exe",
      joinWindowsPath(programFiles, "mpv\\mpv.exe"),
      joinWindowsPath(programFiles, "MPV Player\\mpv.exe"),
    ];
  }
  return [
    "/usr/bin/mpv",
    "/usr/local/bin/mpv",
    join(deps.homeDirectory, ".local/bin/mpv"),
    "/snap/bin/mpv",
    "/var/lib/flatpak/exports/bin/io.mpv.Mpv",
    join(deps.homeDirectory, ".local/share/flatpak/exports/bin/io.mpv.Mpv"),
  ];
}

export async function probeLoginShell(command: string, deps: MpvLocatorDeps): Promise<string | null> {
  if (deps.platform === "win32") return null;
  const result = await deps.runCommand(deps.env.SHELL ?? "/bin/sh", ["-ilc", `command -v ${command}`], {
    env: deps.env,
    timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
  });
  if (result.errorCode || result.code !== 0) return null;
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  return paths[paths.length - 1] ?? null;
}

function addPath(candidates: MpvCandidate[], value: string | null | undefined, source: MpvSource, explicit: boolean): void {
  const binaryPath = value?.trim();
  if (binaryPath) candidates.push({ binaryPath, explicit, source });
}

/** `node:path` follows the host OS, so Windows candidate paths are joined explicitly. */
export function joinWindowsPath(base: string, relativePath: string): string {
  return `${base.replace(/\\+$/, "")}\\${relativePath}`;
}
