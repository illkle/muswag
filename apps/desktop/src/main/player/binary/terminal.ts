import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { MpvInstallMethod } from "#shared/commands/player";
import { InstallFailed } from "../errors";
import type { MpvLocatorDeps } from "./mpv-locator";

/**
 * A program that opens a terminal window. `own` is the terminal itself, which outlives the app.
 * `launcher` only asks the system for one, without a window of its own, and is done when it has.
 * `script` is written to a file first, whose path goes last in `args`.
 */
export type TerminalLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly window: "own" | "launcher";
  readonly script?: { readonly extension: string; readonly content: string };
};

/** How long a terminal has to fail before it counts as open: a terminal that cannot run here exits at once. */
const STARTUP_GRACE_MS = 1_500;

const DONE = "Finished. Go back to muswag and check again.";

/**
 * Terminals as Linux desktops ship them, each with what comes before the command it is to run and the
 * display it needs: foot draws on Wayland only, xterm on X11 only (which Wayland desktops provide too).
 * `x-terminal-emulator` is last: Debian's wrapper for GNOME Terminal joins `-e`'s arguments into one
 * string. (Reasoned, not tried on Linux.)
 */
const LINUX_TERMINALS: ReadonlyArray<readonly [name: string, prefix: readonly string[], display: "any" | "wayland" | "x11"]> = [
  ["ptyxis", ["--"], "any"],
  ["gnome-terminal", ["--"], "any"],
  ["konsole", ["-e"], "any"],
  ["xfce4-terminal", ["-x"], "any"],
  ["kitty", [], "any"],
  ["alacritty", ["-e"], "any"],
  ["foot", [], "wayland"],
  ["wezterm", ["start", "--"], "any"],
  ["xterm", ["-e"], "x11"],
  ["x-terminal-emulator", ["-e"], "any"],
];

/** PowerShell takes the curly single quotes for quotes too, so they are doubled like the straight one. */
const powershellQuote = (value: string) => `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** What `-EncodedCommand` takes: no quoting survives the command lines in between better than none. */
const encodePowershell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/**
 * How to open a terminal window that runs `managerPath args`, the package manager the app found, so
 * that the user sees it work and answers what it asks: the ways to try, in order, none when this
 * computer has no terminal the app knows how to open. The manager is named by its path: the app's PATH
 * may not have it yet.
 */
export const planTerminal = Effect.fn("planTerminal")(function* (
  install: { readonly method: MpvInstallMethod; readonly managerPath: string; readonly args: readonly string[] },
  deps: MpvLocatorDeps,
): Effect.fn.Return<TerminalLaunch[]> {
  if (deps.platform === "win32") {
    // PowerShell started by the app would inherit its output, which goes nowhere. `Start-Process` gives
    // it a console window of its own instead; Chocolatey installs for every user, so its window is an
    // administrator's, which Windows asks about first.
    const run = `& ${[install.managerPath, ...install.args].map(powershellQuote).join(" ")}; Write-Host ''; Write-Host ${powershellQuote(DONE)}`;
    const window = ["-NoExit", "-EncodedCommand", encodePowershell(run)].map(powershellQuote).join(",");
    const start = `Start-Process powershell.exe ${install.method === "choco" ? "-Verb RunAs " : ""}-ArgumentList ${window}`;
    return [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowershell(start)], window: "launcher" }];
  }
  if (deps.platform === "linux") {
    const wayland = Boolean(deps.env.WAYLAND_DISPLAY);
    const x11 = Boolean(deps.env.DISPLAY);
    const script = `sudo ${[install.managerPath, ...install.args].map(shellQuote).join(" ")}; echo; printf '%s ' ${shellQuote(`${DONE} Press Enter to close this window.`)}; read _`;
    const directories = (deps.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean);
    const launches: TerminalLaunch[] = [];
    for (const [name, prefix, display] of LINUX_TERMINALS) {
      if (display === "any" ? !wayland && !x11 : display === "wayland" ? !wayland : !x11) continue;
      for (const directory of directories) {
        const command = `${directory}/${name}`;
        if (yield* deps.fileExists(command)) {
          launches.push({ command, args: [...prefix, "sh", "-c", script], window: "own" });
          break;
        }
      }
    }
    return launches;
  }
  if (deps.platform === "darwin") {
    // Terminal runs a `.command` file it is given, which asks for no permission to control it. The
    // file removes itself first: it is the one copy of the script.
    const content = `#!/bin/sh\nrm -f -- "$0"\n${[install.managerPath, ...install.args].map(shellQuote).join(" ")}\necho\necho ${shellQuote(DONE)}\n`;
    return [{ command: "open", args: ["-a", "Terminal"], window: "launcher", script: { extension: ".command", content } }];
  }
  return [];
});

const cannotOpen = () => new InstallFailed({ operation: "install", message: "The terminal could not be opened. Copy the command and run it in a terminal." });

/**
 * Opens the first of `launches` that works, and lets it outlive the app: it is the user's window from
 * then on. One that fails at once, a terminal that cannot draw on this display say, makes way for the next.
 */
export const launchTerminal = Effect.fn("launchTerminal")(function* (launches: readonly TerminalLaunch[]) {
  for (const launch of launches) {
    const args = [...launch.args];
    const script = launch.script ? join(tmpdir(), `muswag-install-mpv-${randomUUID()}${launch.script.extension}`) : null;
    if (script) {
      const content = launch.script!.content;
      yield* Effect.tryPromise({ try: () => writeFile(script, content, { mode: 0o755 }), catch: cannotOpen });
      args.push(script);
    }
    if (yield* start(launch, args)) return;
    // Nothing ran the script, so nothing removes it.
    if (script) yield* Effect.promise(() => rm(script, { force: true }));
  }
  return yield* cannotOpen();
});

/** Whether `launch` started: a launcher that finished asking, or a terminal still open after a moment. */
const start = (launch: TerminalLaunch, args: readonly string[]) =>
  Effect.callback<boolean>((resume) => {
    const child = spawn(launch.command, args, { detached: launch.window === "own", stdio: "ignore", windowsHide: true });
    let settled = false;
    const settle = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      child.unref();
      resume(Effect.succeed(started));
    };
    const grace = setTimeout(() => settle(true), STARTUP_GRACE_MS);
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
