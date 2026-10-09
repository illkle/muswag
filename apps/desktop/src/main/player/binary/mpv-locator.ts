import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MpvSource } from "#shared/commands/player";
import { runCommand, type CommandResult } from "../support/exec";

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 3_000;

export type MpvLocatorDeps = {
  env: Record<string, string | undefined>;
  fileExists: (filePath: string) => Effect.Effect<boolean>;
  homeDirectory: string;
  platform: NodeJS.Platform;
  runCommand: (...args: Parameters<typeof runCommand>) => Effect.Effect<CommandResult>;
};

export type MpvCandidate = { binaryPath: string; source: MpvSource; explicit: boolean };

export const createMpvLocatorDeps = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    env: process.env,
    // Discovery checks existence; the version probe verifies executability.
    fileExists: (filePath: string) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
    homeDirectory: homedir(),
    platform: process.platform,
    runCommand: (...args: Parameters<typeof runCommand>) => runCommand(...args).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  } satisfies MpvLocatorDeps;
});

/**
 * Where mpv may be, the likeliest place first, found without running anything: the binary the
 * environment or the user names, the one that worked last time, PATH, and the usual install
 * locations that exist. A login shell is asked only after these (`probeLoginShell`).
 */
export const collectMpvCandidates = Effect.fn("collectMpvCandidates")(function* (
  options: { manualPath?: string | null; cachedPath?: string | null },
  deps: MpvLocatorDeps,
): Effect.fn.Return<MpvCandidate[]> {
  const candidates: MpvCandidate[] = [];
  addPath(candidates, deps.env.MUSWAG_MPV_PATH, "env", true);
  addPath(candidates, options.manualPath, "manual", true);
  addPath(candidates, options.cachedPath, "cache", false);
  candidates.push({ binaryPath: deps.platform === "win32" ? "mpv.exe" : "mpv", explicit: false, source: "path" });

  for (const binaryPath of getWellKnownMpvPaths(deps)) {
    if (yield* deps.fileExists(binaryPath)) {
      candidates.push({ binaryPath, explicit: false, source: "well-known" });
    }
  }
  return candidates;
});

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
  // Not the Flatpak or snap wrappers: a sandboxed mpv is given a /tmp of its own, so it would pass the
  // version check and then open its socket where the app cannot see it. (Reasoned, not tried on Linux.)
  return ["/usr/bin/mpv", "/usr/local/bin/mpv", join(deps.homeDirectory, ".local/bin/mpv")];
}

/** What a login shell finds on its PATH. Starting one takes from a fraction of a second to seconds. */
export const probeLoginShell = Effect.fn("probeLoginShell")(function* (command: string, deps: MpvLocatorDeps): Effect.fn.Return<string | null> {
  if (deps.platform === "win32") return null;
  const result = yield* deps.runCommand(deps.env.SHELL ?? "/bin/sh", ["-ilc", `command -v ${command}`], {
    env: deps.env,
    timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
  });
  if (result.errorCode || result.code !== 0) return null;
  const paths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));
  return paths[paths.length - 1] ?? null;
});

function addPath(candidates: MpvCandidate[], value: string | null | undefined, source: MpvSource, explicit: boolean): void {
  const binaryPath = value?.trim();
  if (binaryPath) candidates.push({ binaryPath, explicit, source });
}

/** `node:path` follows the host OS, so Windows candidate paths are joined explicitly. */
export function joinWindowsPath(base: string, relativePath: string): string {
  return `${base.replace(/\\+$/, "")}\\${relativePath}`;
}
