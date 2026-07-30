import { describe, expect, it, vi } from "vitest";

import type { CommandResult, MpvLocatorDeps } from "./mpv-locator";
import { detectInstallOptions, resolveMpvBinary } from "./mpv-locator";

const notFound: CommandResult = { code: null, errorCode: "ENOENT", stderr: "", stdout: "" };

function versionOutput(version = "0.40.0"): CommandResult {
  return { code: 0, errorCode: null, stderr: "", stdout: `mpv v${version} Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects\n` };
}

type CommandHandler = (command: string, args: string[]) => CommandResult | undefined;

function createDeps(
  overrides: { existingPaths?: string[]; handleCommand?: CommandHandler; platform?: NodeJS.Platform } = {},
): MpvLocatorDeps {
  const existingPaths = new Set(overrides.existingPaths ?? []);

  return {
    env: {},
    fileExists: (filePath) => Promise.resolve(existingPaths.has(filePath)),
    homeDirectory: "/Users/tester",
    platform: overrides.platform ?? "darwin",
    runCommand: (command, args) => Promise.resolve(overrides.handleCommand?.(command, args) ?? notFound),
  };
}

/** Answers `--version` probes for the given paths and reports everything else as absent. */
function versionProbes(runnablePaths: Record<string, CommandResult>): CommandHandler {
  return (command, args) => (args[0] === "--version" ? runnablePaths[command] : undefined);
}

describe("resolveMpvBinary", () => {
  it("prefers MUSWAG_MPV_PATH over everything else", async () => {
    const deps = createDeps({
      existingPaths: ["/opt/homebrew/bin/mpv"],
      handleCommand: versionProbes({ "/custom/mpv": versionOutput("0.39.0"), "/opt/homebrew/bin/mpv": versionOutput() }),
    });

    const state = await resolveMpvBinary({}, { ...deps, env: { MUSWAG_MPV_PATH: "/custom/mpv" } });

    expect(state).toEqual({ binaryPath: "/custom/mpv", source: "env", status: "ready", version: "0.39.0" });
  });

  it("reports an explicitly chosen binary that cannot run as invalid instead of looking elsewhere", async () => {
    const deps = createDeps({
      existingPaths: ["/opt/homebrew/bin/mpv"],
      handleCommand: versionProbes({
        "/Users/tester/broken/mpv": { code: 126, errorCode: null, stderr: "bad CPU type in executable\n", stdout: "" },
        "/opt/homebrew/bin/mpv": versionOutput(),
      }),
    });

    const state = await resolveMpvBinary({ manualPath: "/Users/tester/broken/mpv" }, deps);

    expect(state.status).toBe("invalid");
    expect(state).toMatchObject({ binaryPath: "/Users/tester/broken/mpv", source: "manual" });
    if (state.status === "invalid") {
      expect(state.reason).toContain("bad CPU type");
    }
  });

  it("silently skips a stale cached path and falls back to a standard install location", async () => {
    const deps = createDeps({
      existingPaths: ["/opt/homebrew/bin/mpv"],
      handleCommand: versionProbes({ "/opt/homebrew/bin/mpv": versionOutput("0.41.0") }),
    });

    const state = await resolveMpvBinary({ cachedPath: "/usr/local/bin/mpv" }, deps);

    expect(state).toEqual({ binaryPath: "/opt/homebrew/bin/mpv", source: "well-known", status: "ready", version: "0.41.0" });
  });

  it("uses a bare mpv when PATH already resolves it", async () => {
    const deps = createDeps({ handleCommand: versionProbes({ mpv: versionOutput() }) });

    const state = await resolveMpvBinary({}, deps);

    expect(state).toEqual({ binaryPath: "mpv", source: "path", status: "ready", version: "0.40.0" });
  });

  it("falls back to the login shell when a packaged app has no useful PATH", async () => {
    const deps = createDeps({
      handleCommand: (command, args) => {
        if (args[0] === "--version") {
          return command === "/opt/custom-brew/bin/mpv" ? versionOutput() : notFound;
        }
        if (command === "/bin/zsh") {
          return { code: 0, errorCode: null, stderr: "", stdout: "/opt/custom-brew/bin/mpv\n" };
        }
        return notFound;
      },
    });

    const state = await resolveMpvBinary({}, { ...deps, env: { SHELL: "/bin/zsh" } });

    expect(state).toEqual({ binaryPath: "/opt/custom-brew/bin/mpv", source: "login-shell", status: "ready", version: "0.40.0" });
  });

  it("reports missing with the paths it tried when nothing is found", async () => {
    const state = await resolveMpvBinary({}, createDeps());

    expect(state.status).toBe("missing");
    if (state.status === "missing") {
      expect(state.checkedPaths).toContain("mpv");
      expect(state.installOptions).toHaveLength(1);
      expect(state.installOptions[0]).toMatchObject({ automatic: false, method: "brew", url: "https://brew.sh" });
    }
  });

  it("reports an unusable standard install as invalid rather than missing", async () => {
    const deps = createDeps({
      existingPaths: ["/opt/homebrew/bin/mpv"],
      handleCommand: versionProbes({
        "/opt/homebrew/bin/mpv": { code: null, errorCode: "EACCES", stderr: "", stdout: "" },
      }),
    });

    const state = await resolveMpvBinary({}, deps);

    expect(state).toMatchObject({ binaryPath: "/opt/homebrew/bin/mpv", source: "well-known", status: "invalid" });
    if (state.status === "invalid") {
      expect(state.reason).toContain("not executable");
    }
  });

  it("survives a login shell probe that times out", async () => {
    const deps = createDeps({
      handleCommand: (_command, args) => (args[0] === "-ilc" ? { code: null, errorCode: "ETIMEDOUT", stderr: "", stdout: "" } : notFound),
    });

    const state = await resolveMpvBinary({}, { ...deps, env: { SHELL: "/bin/zsh" } });

    expect(state.status).toBe("missing");
  });

  it("does not probe the same path twice", async () => {
    const runCommand = vi.fn((command: string, args: string[]) =>
      Promise.resolve(args[0] === "--version" && command === "/opt/homebrew/bin/mpv" ? versionOutput() : notFound),
    );
    const deps = { ...createDeps({ existingPaths: ["/opt/homebrew/bin/mpv"] }), runCommand };

    await resolveMpvBinary({ cachedPath: "/opt/homebrew/bin/mpv" }, deps);

    const versionProbeCount = runCommand.mock.calls.filter(([, args]) => args[0] === "--version").length;
    expect(versionProbeCount).toBe(1);
  });

  it("falls back to the raw output when the version cannot be parsed", async () => {
    const deps = createDeps({
      handleCommand: versionProbes({ mpv: { code: 0, errorCode: null, stderr: "", stdout: "some custom build\n" } }),
    });

    const state = await resolveMpvBinary({}, deps);

    expect(state).toMatchObject({ status: "ready", version: "some custom build" });
  });
});

describe("detectInstallOptions", () => {
  it("offers a one-click Homebrew install when brew is present", async () => {
    const deps = createDeps({ existingPaths: ["/opt/homebrew/bin/brew"] });

    const options = await detectInstallOptions(deps);

    expect(options).toEqual([{ automatic: true, command: "brew install mpv", method: "brew", note: null, url: null }]);
  });

  it("finds brew through the login shell when it lives in a custom prefix", async () => {
    const deps = createDeps({
      handleCommand: (command, args) =>
        command === "/bin/zsh" && args[1] === "command -v brew"
          ? { code: 0, errorCode: null, stderr: "", stdout: "/opt/custom-brew/bin/brew\n" }
          : notFound,
    });

    const options = await detectInstallOptions({ ...deps, env: { SHELL: "/bin/zsh" } });

    expect(options[0]).toMatchObject({ automatic: true, method: "brew" });
  });

  it("only suggests package managers that exist on Linux", async () => {
    const deps = createDeps({ existingPaths: ["/usr/bin/pacman", "/usr/bin/flatpak"], platform: "linux" });

    const options = await detectInstallOptions(deps);

    expect(options.map((option) => option.method)).toEqual(["pacman", "flatpak"]);
    expect(options.every((option) => !option.automatic)).toBe(true);
  });

  it("offers scoop as an automatic install on Windows when present", async () => {
    const deps = createDeps({ existingPaths: ["/Users/tester\\scoop\\shims\\scoop.cmd"], platform: "win32" });

    const options = await detectInstallOptions(deps);

    expect(options).toEqual([{ automatic: true, command: "scoop install extras/mpv", method: "scoop", note: null, url: null }]);
  });

  it("still explains what to do on Windows without a package manager", async () => {
    const options = await detectInstallOptions(createDeps({ platform: "win32" }));

    expect(options[0]).toMatchObject({ automatic: false, method: "scoop", url: "https://scoop.sh" });
  });
});
