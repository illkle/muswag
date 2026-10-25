import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { MpvSource } from "#shared/commands/player";
import { runCommand, type CommandResult } from "../support/exec";

const LOGIN_SHELL_PROBE_TIMEOUT_MS = 3_000;
const WINDOWS_PATH_PROBE_TIMEOUT_MS = 5_000;
/**
 * The machine PATH and then the user's, as Windows joins them for a new process. Sent as base64 of
 * UTF-8, so a non-ASCII user name survives whatever code page the console has, or the lack of one.
 */
const WINDOWS_PATH_SCRIPT =
  "$path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'); [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))";
/** The folder `winget install --id mpv-player.mpv-CI.MSVC --scope user` unpacks mpv into. */
const WINGET_MPV_PACKAGE = "Microsoft\\WinGet\\Packages\\mpv-player.mpv-CI.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe\\mpv.exe";

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
 * locations that exist. PATH as it is now, not as the app got it, is looked at only after these (`probeFreshPath`).
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
    // The mpv package leaves no command alias in WinGet\Links: its mpv.exe needs the DLLs beside it, so
    // WinGet adds the package folder to the user's PATH instead, which the running app does not see.
    return [
      ...(deps.env.LOCALAPPDATA ? [joinWindowsPath(deps.env.LOCALAPPDATA, WINGET_MPV_PACKAGE), joinWindowsPath(deps.env.LOCALAPPDATA, "Microsoft\\WinGet\\Links\\mpv.exe")] : []),
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

/**
 * Where `command` is on the PATH a program started now would get. The app's own PATH is the one it
 * started with, so it misses what an installer has added since: on macOS and Linux a login shell is
 * asked, and on Windows, where an installer changes PATH in the registry, the registry is read
 * (`command` names the file, with its extension). Either takes from a fraction of a second to seconds.
 */
export const probeFreshPath = Effect.fn("probeFreshPath")(function* (command: string, deps: MpvLocatorDeps): Effect.fn.Return<string | null> {
  if (deps.platform === "win32") return yield* findOnWindowsPath(command, yield* readWindowsPath(deps), deps);
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

/** The directories of the PATH Windows gives a new process, with the variables in them expanded. */
export const readWindowsPath = Effect.fn("readWindowsPath")(function* (deps: MpvLocatorDeps): Effect.fn.Return<string[]> {
  const result = yield* deps.runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PATH_SCRIPT], {
    env: deps.env,
    timeoutMs: WINDOWS_PATH_PROBE_TIMEOUT_MS,
  });
  if (result.errorCode || result.code !== 0) return [];
  return Buffer.from(result.stdout.trim(), "base64")
    .toString("utf8")
    .split(";")
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
});

export const findOnWindowsPath = Effect.fn("findOnWindowsPath")(function* (fileName: string, directories: readonly string[], deps: MpvLocatorDeps): Effect.fn.Return<string | null> {
  for (const directory of directories) {
    const filePath = joinWindowsPath(directory, fileName);
    if (yield* deps.fileExists(filePath)) return filePath;
  }
  return null;
});

function addPath(candidates: MpvCandidate[], value: string | null | undefined, source: MpvSource, explicit: boolean): void {
  const binaryPath = value?.trim();
  if (binaryPath) candidates.push({ binaryPath, explicit, source });
}

/** `node:path` follows the host OS, so Windows candidate paths are joined explicitly. */
export function joinWindowsPath(base: string, relativePath: string): string {
  return `${base.replace(/\\+$/, "")}\\${relativePath}`;
}
