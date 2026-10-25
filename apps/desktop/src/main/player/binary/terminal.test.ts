import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import type { MpvLocatorDeps } from "./mpv-locator";
import { launchTerminal, planTerminal } from "./terminal";

function deps(overrides: Partial<MpvLocatorDeps>): MpvLocatorDeps {
  return {
    env: {},
    fileExists: () => Effect.succeed(false),
    homeDirectory: "/home/test",
    platform: "linux",
    runCommand: () => Effect.die("unused"),
    ...overrides,
  };
}

/** The script a PowerShell `-EncodedCommand` runs. */
const decoded = (args: readonly string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
/** The script of the window `Start-Process` opens, from the launcher's own script. */
const windowScript = (start: string) => Buffer.from(start.match(/'-EncodedCommand','([A-Za-z0-9+/=]+)'$/)![1]!, "base64").toString("utf16le");

const apt = { method: "apt" as const, managerPath: "/usr/bin/apt", args: ["install", "mpv"] };

describe("terminal for an install", () => {
  it.effect("has PowerShell open a console window of its own on Windows, running the manager by its path", () =>
    Effect.gen(function* () {
      const [launch, ...rest] = yield* planTerminal({ method: "scoop", managerPath: "C:\\Users\\O'Neil’s\\scoop\\shims\\scoop.cmd", args: ["install", "extras/mpv"] }, deps({ platform: "win32" }));
      expect(rest).toEqual([]);
      expect(launch).toMatchObject({ command: "powershell.exe", window: "launcher" });
      const start = decoded(launch!.args);
      expect(start).toMatch(/^Start-Process powershell\.exe -ArgumentList '-NoExit','-EncodedCommand','[A-Za-z0-9+/=]+'$/);
      // Straight and curly single quotes alike are doubled: PowerShell ends a quoted string at either.
      expect(windowScript(start)).toMatch(/^& 'C:\\Users\\O''Neil’’s\\scoop\\shims\\scoop\.cmd' 'install' 'extras\/mpv';/);
    }),
  );

  it.effect("asks Windows for an administrator's window for Chocolatey", () =>
    Effect.gen(function* () {
      const [launch] = yield* planTerminal({ method: "choco", managerPath: "C:\\ProgramData\\chocolatey\\bin\\choco.exe", args: ["install", "mpv", "-y"] }, deps({ platform: "win32" }));
      const start = decoded(launch!.args);
      expect(start).toMatch(/^Start-Process powershell\.exe -Verb RunAs -ArgumentList /);
      expect(windowScript(start)).toContain("& 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' 'install' 'mpv' '-y';");
    }),
  );

  it.effect("tries the terminals found on Linux in order, running the manager with sudo", () =>
    Effect.gen(function* () {
      const launches = yield* planTerminal(
        apt,
        deps({ env: { PATH: "/usr/local/bin:/usr/bin", DISPLAY: ":0" }, fileExists: (path) => Effect.succeed(path === "/usr/bin/konsole" || path === "/usr/bin/xterm") }),
      );
      expect(launches.map((launch) => launch.command)).toEqual(["/usr/bin/konsole", "/usr/bin/xterm"]);
      expect(launches[0]!.args.slice(0, 3)).toEqual(["-e", "sh", "-c"]);
      expect(launches[0]!.args[3]).toMatch(/^sudo '\/usr\/bin\/apt' 'install' 'mpv'; /);
    }),
  );

  it.effect("leaves out Linux terminals that cannot draw on the session's display", () =>
    Effect.gen(function* () {
      const installed = (path: string) => Effect.succeed(path === "/usr/bin/foot" || path === "/usr/bin/xterm");
      const on = (env: Record<string, string>) =>
        planTerminal(apt, deps({ env: { PATH: "/usr/bin", ...env }, fileExists: installed })).pipe(Effect.map((launches) => launches.map((launch) => launch.command)));
      expect(yield* on({ DISPLAY: ":0" })).toEqual(["/usr/bin/xterm"]);
      expect(yield* on({ WAYLAND_DISPLAY: "wayland-0" })).toEqual(["/usr/bin/foot"]);
      expect(yield* on({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })).toEqual(["/usr/bin/foot", "/usr/bin/xterm"]);
      // No display at all: no window could be opened.
      expect(yield* on({})).toEqual([]);
    }),
  );

  it.effect("opens Terminal on macOS with a script that removes itself", () =>
    Effect.gen(function* () {
      const [launch] = yield* planTerminal({ method: "brew", managerPath: "/opt/homebrew/bin/brew", args: ["install", "mpv"] }, deps({ platform: "darwin" }));
      expect(launch).toMatchObject({ command: "open", args: ["-a", "Terminal"], window: "launcher", script: { extension: ".command" } });
      expect(launch!.script!.content).toMatch(/^#!\/bin\/sh\nrm -f -- "\$0"\n'\/opt\/homebrew\/bin\/brew' 'install' 'mpv'\n/);
    }),
  );

  it.effect.skipIf(process.platform === "win32")("goes on to the next terminal when one fails at once, and says when none opened", () =>
    Effect.gen(function* () {
      yield* launchTerminal([
        { command: "/nonexistent/terminal", args: [], window: "own" },
        { command: "false", args: [], window: "own" },
        { command: "true", args: [], window: "own" },
      ]);
      const failed = yield* launchTerminal([{ command: "false", args: [], window: "own" }]).pipe(Effect.flip);
      expect(failed.message).toBe("The terminal could not be opened. Copy the command and run it in a terminal.");
    }),
  );
});
