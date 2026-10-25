import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import type { MpvInstallMethod } from "#shared/commands/player";
import { InstallFailed } from "../errors";
import type { MpvLocatorDeps } from "./mpv-locator";

/**
 * A program that opens a terminal window of its own. `hidden` runs without a window: it only asks for
 * one, and is done when it has. `script` is written to a file first, whose path goes last in `args`.
 */
export type TerminalLaunch = {
  readonly command: string;
  readonly args: readonly string[];
  readonly window: "own" | "hidden";
  readonly script?: { readonly extension: string; readonly content: string };
};

const DONE = "Finished. Go back to muswag and check again.";

/**
 * Terminals as Linux desktops ship them, each with what comes before the command it is to run.
 * `x-terminal-emulator` is last: Debian's wrapper for GNOME Terminal joins `-e`'s arguments into one
 * string. (Reasoned, not tried on Linux.)
 */
const LINUX_TERMINALS: ReadonlyArray<readonly [name: string, prefix: readonly string[]]> = [
  ["ptyxis", ["--"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["foot", []],
  ["wezterm", ["start", "--"]],
  ["xterm", ["-e"]],
  ["x-terminal-emulator", ["-e"]],
];

const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
/** What `-EncodedCommand` takes: no quoting survives the command lines in between better than none. */
const encodePowershell = (script: string) => Buffer.from(script, "utf16le").toString("base64");

/**
 * How to open a terminal window that runs `managerPath args`, the package manager the app found, so
 * that the user sees it work and answers what it asks. Null when this computer has no terminal the app
 * knows how to open. The manager is named by its path: the app's PATH may not have it yet.
 */
export const planTerminal = Effect.fn("planTerminal")(function* (
  install: { readonly method: MpvInstallMethod; readonly managerPath: string; readonly args: readonly string[] },
  deps: MpvLocatorDeps,
): Effect.fn.Return<TerminalLaunch | null> {
  if (deps.platform === "win32") {
    const run = `& ${[install.managerPath, ...install.args].map(powershellQuote).join(" ")}; Write-Host ''; Write-Host ${powershellQuote(DONE)}`;
    const own = ["-NoExit", "-EncodedCommand", encodePowershell(run)];
    // Chocolatey installs for every user, so it needs an administrator's window, which Windows asks about.
    if (install.method === "choco")
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowershell(`Start-Process powershell.exe -Verb RunAs -ArgumentList ${own.map(powershellQuote).join(",")}`)],
        window: "hidden",
      };
    return { command: "powershell.exe", args: own, window: "own" };
  }
  if (deps.platform === "linux") {
    const script = `sudo ${[install.managerPath, ...install.args].map(shellQuote).join(" ")}; echo; printf '%s ' ${shellQuote(`${DONE} Press Enter to close this window.`)}; read _`;
    const directories = (deps.env.PATH ?? "/usr/bin:/bin").split(":").filter(Boolean);
    for (const [name, prefix] of LINUX_TERMINALS) {
      for (const directory of directories) {
        const command = `${directory}/${name}`;
        if (yield* deps.fileExists(command)) return { command, args: [...prefix, "sh", "-c", script], window: "own" };
      }
    }
    return null;
  }
  if (deps.platform === "darwin") {
    // Terminal runs a `.command` file it is given, which asks for no permission to control it. The
    // file removes itself first: it is the one copy of the script.
    const content = `#!/bin/sh\nrm -f -- "$0"\n${[install.managerPath, ...install.args].map(shellQuote).join(" ")}\necho\necho ${shellQuote(DONE)}\n`;
    return { command: "open", args: ["-a", "Terminal"], window: "hidden", script: { extension: ".command", content } };
  }
  return null;
});

const cannotOpen = () => new InstallFailed({ operation: "install", message: "The terminal could not be opened. Copy the command and run it in a terminal." });

/** Starts the terminal and lets it outlive the app: it is the user's window from then on. */
export const launchTerminal = Effect.fn("launchTerminal")(function* (launch: TerminalLaunch) {
  const args = [...launch.args];
  if (launch.script) {
    const path = join(tmpdir(), `muswag-install-mpv-${randomUUID()}${launch.script.extension}`);
    const content = launch.script.content;
    yield* Effect.tryPromise({ try: () => writeFile(path, content, { mode: 0o755 }), catch: cannotOpen });
    args.push(path);
  }
  yield* spawnDetached(launch, args);
});

const spawnDetached = (launch: TerminalLaunch, args: readonly string[]) =>
  Effect.callback<void, InstallFailed>((resume) => {
    const child = spawn(launch.command, args, {
      detached: launch.window === "own",
      stdio: "ignore",
      windowsHide: launch.window === "hidden",
    });
    child.once("error", () => resume(Effect.fail(cannotOpen())));
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
  });
