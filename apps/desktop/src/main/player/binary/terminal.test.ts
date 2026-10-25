import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import type { MpvLocatorDeps } from "./mpv-locator";
import { planTerminal } from "./terminal";

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

describe("terminal for an install", () => {
  it.effect("opens PowerShell running the manager by its path on Windows", () =>
    Effect.gen(function* () {
      const launch = yield* planTerminal({ method: "scoop", managerPath: "C:\\Users\\O'Neil\\scoop\\shims\\scoop.cmd", args: ["install", "extras/mpv"] }, deps({ platform: "win32" }));
      expect(launch).toMatchObject({ command: "powershell.exe", window: "own" });
      expect(launch!.args.slice(0, 2)).toEqual(["-NoExit", "-EncodedCommand"]);
      expect(decoded(launch!.args)).toMatch(/^& 'C:\\Users\\O''Neil\\scoop\\shims\\scoop\.cmd' 'install' 'extras\/mpv';/);
    }),
  );

  it.effect("asks Windows for an administrator's window for Chocolatey", () =>
    Effect.gen(function* () {
      const launch = yield* planTerminal({ method: "choco", managerPath: "C:\\ProgramData\\chocolatey\\bin\\choco.exe", args: ["install", "mpv", "-y"] }, deps({ platform: "win32" }));
      expect(launch).toMatchObject({ command: "powershell.exe", window: "hidden" });
      const elevate = decoded(launch!.args);
      expect(elevate).toMatch(/^Start-Process powershell\.exe -Verb RunAs -ArgumentList '-NoExit','-EncodedCommand','[A-Za-z0-9+/=]+'$/);
      const inner = elevate.match(/'([A-Za-z0-9+/=]+)'$/)![1]!;
      expect(Buffer.from(inner, "base64").toString("utf16le")).toContain("& 'C:\\ProgramData\\chocolatey\\bin\\choco.exe' 'install' 'mpv' '-y';");
    }),
  );

  it.effect("runs the manager with sudo in the first terminal found on Linux", () =>
    Effect.gen(function* () {
      const launch = yield* planTerminal(
        { method: "apt", managerPath: "/usr/bin/apt", args: ["install", "mpv"] },
        deps({ env: { PATH: "/usr/local/bin:/usr/bin" }, fileExists: (path) => Effect.succeed(path === "/usr/bin/konsole" || path === "/usr/bin/xterm") }),
      );
      expect(launch).toMatchObject({ command: "/usr/bin/konsole", window: "own" });
      expect(launch!.args.slice(0, 3)).toEqual(["-e", "sh", "-c"]);
      expect(launch!.args[3]).toMatch(/^sudo '\/usr\/bin\/apt' 'install' 'mpv'; /);
    }),
  );

  it.effect("has none to offer on Linux without a terminal it knows", () =>
    Effect.gen(function* () {
      expect(yield* planTerminal({ method: "apt", managerPath: "/usr/bin/apt", args: ["install", "mpv"] }, deps({}))).toBeNull();
    }),
  );

  it.effect("opens Terminal on macOS with a script that removes itself", () =>
    Effect.gen(function* () {
      const launch = yield* planTerminal({ method: "brew", managerPath: "/opt/homebrew/bin/brew", args: ["install", "mpv"] }, deps({ platform: "darwin" }));
      expect(launch).toMatchObject({ command: "open", args: ["-a", "Terminal"], script: { extension: ".command" } });
      expect(launch!.script!.content).toMatch(/^#!\/bin\/sh\nrm -f -- "\$0"\n'\/opt\/homebrew\/bin\/brew' 'install' 'mpv'\n/);
    }),
  );
});
