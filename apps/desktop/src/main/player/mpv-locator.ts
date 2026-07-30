import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MpvInstallMethod, MpvInstallOption, MpvSource, MpvState } from "../../shared/player";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_PROBE_TIMEOUT_MS = 3_000;

export type CommandResult = {
  /** Exit code, or null when the process failed to start or was killed. */
  code: number | null;
  /** Set when the process could not be spawned at all (`ENOENT`, `EACCES`, …). */
  errorCode: string | null;
  stderr: string;
  stdout: string;
};

export type MpvLocatorDeps = {
  env: Record<string, string | undefined>;
  fileExists: (filePath: string) => Promise<boolean>;
  homeDirectory: string;
  platform: NodeJS.Platform;
  runCommand: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<CommandResult>;
};

export type ResolveMpvBinaryOptions = {
  /** Path the user picked explicitly. A broken path here is reported instead of being skipped. */
  manualPath?: string | null;
  /** Path remembered from a previous successful resolution. Skipped silently when broken. */
  cachedPath?: string | null;
};

/** An install option plus the details needed to actually run it. */
export type MpvInstallCandidate = {
  args: string[];
  /** Absolute path of the package manager binary, when it was found. */
  managerPath: string | null;
  option: MpvInstallOption;
};

type Candidate = {
  binaryPath: string;
  /** Explicit candidates are reported as `invalid` rather than skipped when they fail to run. */
  explicit: boolean;
  source: MpvSource;
};

export function createMpvLocatorDeps(): MpvLocatorDeps {
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
  };
}

export async function resolveMpvBinary(options: ResolveMpvBinaryOptions = {}, overrides: Partial<MpvLocatorDeps> = {}): Promise<MpvState> {
  const deps = { ...createMpvLocatorDeps(), ...overrides };
  const checkedPaths: string[] = [];
  let firstInvalid: { binaryPath: string; reason: string; source: MpvSource } | undefined;

  for (const candidate of await collectCandidates(options, deps)) {
    if (checkedPaths.includes(candidate.binaryPath)) {
      continue;
    }
    checkedPaths.push(candidate.binaryPath);

    const validation = await validateMpvBinary(candidate.binaryPath, deps);
    if (validation.ok) {
      return {
        binaryPath: candidate.binaryPath,
        source: candidate.source,
        status: "ready",
        version: validation.version,
      };
    }

    if (validation.missing) {
      continue;
    }

    // The binary is there but unusable (quarantined, wrong arch, dangling symlink, …).
    if (candidate.explicit) {
      return {
        binaryPath: candidate.binaryPath,
        installOptions: await detectInstallOptions(deps),
        reason: validation.reason,
        source: candidate.source,
        status: "invalid",
      };
    }

    firstInvalid ??= { binaryPath: candidate.binaryPath, reason: validation.reason, source: candidate.source };
  }

  const installOptions = await detectInstallOptions(deps);
  if (firstInvalid) {
    return { ...firstInvalid, installOptions, status: "invalid" };
  }

  return { checkedPaths, installOptions, status: "missing" };
}

export async function validateMpvBinary(
  binaryPath: string,
  overrides: Partial<MpvLocatorDeps> = {},
): Promise<{ ok: true; version: string } | { ok: false; missing: boolean; reason: string }> {
  const deps = { ...createMpvLocatorDeps(), ...overrides };
  const result = await deps.runCommand(binaryPath, ["--version"], { env: deps.env, timeoutMs: VERSION_PROBE_TIMEOUT_MS });

  if (result.errorCode === "ENOENT") {
    return { missing: true, ok: false, reason: "The file does not exist." };
  }

  if (result.errorCode) {
    return { missing: false, ok: false, reason: describeSpawnErrorCode(result.errorCode) };
  }

  if (result.code !== 0) {
    const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
    return {
      missing: false,
      ok: false,
      reason: detail ? `\`--version\` exited with code ${result.code}: ${detail}` : `\`--version\` exited with code ${result.code}.`,
    };
  }

  return { ok: true, version: parseMpvVersion(result.stdout) };
}

export async function detectInstallCandidates(overrides: Partial<MpvLocatorDeps> = {}): Promise<MpvInstallCandidate[]> {
  const deps = { ...createMpvLocatorDeps(), ...overrides };

  if (deps.platform === "darwin") {
    return detectMacInstallCandidates(deps);
  }

  if (deps.platform === "win32") {
    return detectWindowsInstallCandidates(deps);
  }

  return detectLinuxInstallCandidates(deps);
}

export async function detectInstallOptions(overrides: Partial<MpvLocatorDeps> = {}): Promise<MpvInstallOption[]> {
  return (await detectInstallCandidates(overrides)).map((candidate) => candidate.option);
}

export function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, errorCode: "ETIMEDOUT", stderr, stdout });
    }, options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (cause: NodeJS.ErrnoException) => {
      finish({ code: null, errorCode: cause.code ?? "UNKNOWN", stderr, stdout });
    });

    child.on("close", (code) => {
      finish({ code, errorCode: null, stderr, stdout });
    });
  });
}

async function collectCandidates(options: ResolveMpvBinaryOptions, deps: MpvLocatorDeps): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const envPath = deps.env.MUSWAG_MPV_PATH?.trim();

  if (envPath) {
    candidates.push({ binaryPath: envPath, explicit: true, source: "env" });
  }

  const manualPath = options.manualPath?.trim();
  if (manualPath) {
    candidates.push({ binaryPath: manualPath, explicit: true, source: "manual" });
  }

  const cachedPath = options.cachedPath?.trim();
  if (cachedPath) {
    candidates.push({ binaryPath: cachedPath, explicit: false, source: "cache" });
  }

  // Bare name: correct in development and on Linux, where PATH is inherited.
  candidates.push({ binaryPath: getBareBinaryName(deps.platform), explicit: false, source: "path" });

  for (const wellKnownPath of getWellKnownPaths(deps)) {
    if (await deps.fileExists(wellKnownPath)) {
      candidates.push({ binaryPath: wellKnownPath, explicit: false, source: "well-known" });
    }
  }

  // Last resort: a packaged macOS app gets launchd's minimal PATH, so ask the user's
  // login shell where mpv lives. Covers custom Homebrew prefixes, nix, asdf, and friends.
  const loginShellPath = await probeLoginShell("mpv", deps);
  if (loginShellPath) {
    candidates.push({ binaryPath: loginShellPath, explicit: false, source: "login-shell" });
  }

  return candidates;
}

function getBareBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "mpv.exe" : "mpv";
}

/** `join` follows the host separator, so Windows paths are built explicitly. */
function joinWindowsPath(base: string, relativePath: string): string {
  return `${base.replace(/\\+$/, "")}\\${relativePath}`;
}

function getWellKnownPaths(deps: MpvLocatorDeps): string[] {
  if (deps.platform === "darwin") {
    return [
      "/opt/homebrew/bin/mpv",
      "/usr/local/bin/mpv",
      "/opt/local/bin/mpv",
      "/Applications/mpv.app/Contents/MacOS/mpv",
      join(deps.homeDirectory, "Applications/mpv.app/Contents/MacOS/mpv"),
    ];
  }

  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA;
    const userProfile = deps.env.USERPROFILE ?? deps.homeDirectory;
    const programFiles = deps.env.ProgramFiles ?? "C:\\Program Files";

    return [
      ...(localAppData ? [joinWindowsPath(localAppData, "Microsoft\\WinGet\\Links\\mpv.exe")] : []),
      joinWindowsPath(userProfile, "scoop\\shims\\mpv.exe"),
      "C:\\ProgramData\\chocolatey\\bin\\mpv.exe",
      joinWindowsPath(programFiles, "mpv\\mpv.exe"),
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

/**
 * Asks the user's login shell to resolve a command, so PATH set up in shell profiles is
 * visible to a packaged app. Never throws and is bounded by a short timeout.
 */
async function probeLoginShell(command: string, deps: MpvLocatorDeps): Promise<string | null> {
  if (deps.platform === "win32") {
    return null;
  }

  const shell = deps.env.SHELL ?? "/bin/sh";
  const result = await deps.runCommand(shell, ["-ilc", `command -v ${command}`], {
    env: deps.env,
    timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
  });
  if (result.errorCode || result.code !== 0) {
    return null;
  }

  // Shell profiles can print banners, so take the last absolute path rather than the first line.
  const absolutePaths = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"));

  return absolutePaths[absolutePaths.length - 1] ?? null;
}

async function findManagerBinary(name: string, wellKnownPaths: string[], deps: MpvLocatorDeps): Promise<string | null> {
  for (const wellKnownPath of wellKnownPaths) {
    if (await deps.fileExists(wellKnownPath)) {
      return wellKnownPath;
    }
  }

  const onPath = await deps.runCommand(deps.platform === "win32" ? "where" : "which", [name], {
    env: deps.env,
    timeoutMs: LOGIN_SHELL_PROBE_TIMEOUT_MS,
  });
  if (!onPath.errorCode && onPath.code === 0) {
    const resolvedPath = firstNonEmptyLine(onPath.stdout);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return probeLoginShell(name, deps);
}

async function detectMacInstallCandidates(deps: MpvLocatorDeps): Promise<MpvInstallCandidate[]> {
  const brewPath = await findManagerBinary("brew", ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"], deps);

  return [
    {
      args: ["install", "mpv"],
      managerPath: brewPath,
      option: {
        automatic: brewPath !== null,
        command: "brew install mpv",
        method: "brew",
        note: brewPath
          ? null
          : "Homebrew is not installed. Install Homebrew first, then run this command in a terminal (or install mpv another way and point Muswag at it).",
        url: brewPath ? null : "https://brew.sh",
      },
    },
  ];
}

async function detectWindowsInstallCandidates(deps: MpvLocatorDeps): Promise<MpvInstallCandidate[]> {
  const candidates: MpvInstallCandidate[] = [];
  const userProfile = deps.env.USERPROFILE ?? deps.homeDirectory;

  const scoopPath = await findManagerBinary("scoop", [joinWindowsPath(userProfile, "scoop\\shims\\scoop.cmd")], deps);
  if (scoopPath) {
    candidates.push({
      args: ["install", "extras/mpv"],
      managerPath: scoopPath,
      option: {
        automatic: true,
        command: "scoop install extras/mpv",
        method: "scoop",
        note: null,
        url: null,
      },
    });
  }

  const chocoPath = await findManagerBinary("choco", ["C:\\ProgramData\\chocolatey\\bin\\choco.exe"], deps);
  if (chocoPath) {
    candidates.push({
      args: ["install", "mpv", "-y"],
      managerPath: chocoPath,
      option: {
        automatic: false,
        command: "choco install mpv",
        method: "choco",
        note: "Chocolatey needs an administrator terminal, so run this yourself and then re-check.",
        url: null,
      },
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      args: ["install", "extras/mpv"],
      managerPath: null,
      option: {
        automatic: false,
        command: "scoop install extras/mpv",
        method: "scoop",
        note: "No supported package manager was found. Install Scoop first, or download mpv and point Muswag at mpv.exe.",
        url: "https://scoop.sh",
      },
    });
  }

  return candidates;
}

async function detectLinuxInstallCandidates(deps: MpvLocatorDeps): Promise<MpvInstallCandidate[]> {
  const managers: { args: string[]; command: string; method: MpvInstallMethod; name: string; wellKnownPaths: string[] }[] = [
    { args: ["install", "mpv"], command: "sudo apt install mpv", method: "apt", name: "apt", wellKnownPaths: ["/usr/bin/apt"] },
    { args: ["install", "mpv"], command: "sudo dnf install mpv", method: "dnf", name: "dnf", wellKnownPaths: ["/usr/bin/dnf"] },
    { args: ["-S", "mpv"], command: "sudo pacman -S mpv", method: "pacman", name: "pacman", wellKnownPaths: ["/usr/bin/pacman"] },
    { args: ["install", "mpv"], command: "sudo zypper install mpv", method: "zypper", name: "zypper", wellKnownPaths: ["/usr/bin/zypper"] },
    {
      args: ["install", "--user", "flathub", "io.mpv.Mpv"],
      command: "flatpak install --user flathub io.mpv.Mpv",
      method: "flatpak",
      name: "flatpak",
      wellKnownPaths: ["/usr/bin/flatpak"],
    },
  ];

  const candidates: MpvInstallCandidate[] = [];
  for (const manager of managers) {
    const managerPath = await findManagerBinary(manager.name, manager.wellKnownPaths, deps);
    if (!managerPath) {
      continue;
    }

    candidates.push({
      args: manager.args,
      managerPath,
      option: {
        // System package managers need root, which the app cannot request on its own.
        automatic: false,
        command: manager.command,
        method: manager.method,
        note: "Run this in a terminal, then re-check.",
        url: null,
      },
    });
  }

  return candidates;
}

function parseMpvVersion(stdout: string): string {
  const match = /^mpv\s+v?(\S+)/im.exec(stdout);
  if (match?.[1]) {
    return match[1];
  }

  return firstNonEmptyLine(stdout) ?? "unknown";
}

function firstNonEmptyLine(value: string): string | null {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function describeSpawnErrorCode(errorCode: string): string {
  if (errorCode === "EACCES") {
    return "The file is not executable.";
  }
  if (errorCode === "ETIMEDOUT") {
    return "`--version` did not finish in time.";
  }
  if (errorCode === "EFTYPE" || errorCode === "ENOEXEC") {
    return "The file is not a runnable binary for this machine.";
  }

  return `The binary could not be started (${errorCode}).`;
}

/** Directory of the package manager binary, so its own child processes stay resolvable. */
export function getManagerBinDirectory(managerPath: string): string {
  return dirname(managerPath);
}
