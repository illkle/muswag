import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { MpvInstallCandidate } from "./mpv-locator";
import { getManagerBinDirectory } from "./mpv-locator";

export type MpvInstallOutput = {
  line: string;
  stream: "stdout" | "stderr";
};

export type MpvInstallResult = { ok: true } | { ok: false; error: string };

let runningInstall: ChildProcess | undefined;
let cancelled = false;

export function isMpvInstallRunning(): boolean {
  return runningInstall !== undefined;
}

export function cancelMpvInstall(): void {
  if (!runningInstall) {
    return;
  }

  cancelled = true;
  runningInstall.kill("SIGTERM");
}

/**
 * Runs a package manager install directly, streaming its output so the user can see progress.
 * Only candidates flagged `automatic` are runnable — everything else needs a terminal.
 */
export function runMpvInstall(candidate: MpvInstallCandidate, onOutput: (output: MpvInstallOutput) => void): Promise<MpvInstallResult> {
  if (!candidate.option.automatic || !candidate.managerPath) {
    return Promise.resolve({
      error: `${candidate.option.command} has to be run manually.`,
      ok: false,
    });
  }

  if (runningInstall) {
    return Promise.resolve({ error: "Another install is already running.", ok: false });
  }

  const managerPath = candidate.managerPath;

  return new Promise<MpvInstallResult>((resolve) => {
    let settled = false;
    const finish = (result: MpvInstallResult) => {
      if (settled) {
        return;
      }
      settled = true;
      runningInstall = undefined;
      resolve(result);
    };

    console.debug("[player][mpv][main]", "install:start", { args: candidate.args, managerPath });
    onOutput({ line: `$ ${candidate.option.command}`, stream: "stdout" });

    cancelled = false;
    const child = spawn(managerPath, candidate.args, {
      env: {
        ...process.env,
        // A packaged app inherits launchd's minimal PATH; the manager needs its own bin dir.
        PATH: [getManagerBinDirectory(managerPath), process.env.PATH, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":"),
        HOMEBREW_COLOR: "0",
        HOMEBREW_NO_ANALYTICS: "1",
        HOMEBREW_NO_AUTO_UPDATE: "1",
        HOMEBREW_NO_ENV_HINTS: "1",
        NONINTERACTIVE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    runningInstall = child;

    forwardLines(child, onOutput);

    child.on("error", (cause: NodeJS.ErrnoException) => {
      console.error("[player][mpv][main]", "install:error", cause);
      finish({ error: cause.message, ok: false });
    });

    child.on("close", (code, signal) => {
      console.debug("[player][mpv][main]", "install:exit", { code, signal });

      if (cancelled) {
        finish({ error: "Install cancelled.", ok: false });
        return;
      }

      if (code === 0) {
        finish({ ok: true });
        return;
      }

      finish({
        error: signal ? `${candidate.option.command} was terminated (${signal}).` : `${candidate.option.command} exited with code ${code}.`,
        ok: false,
      });
    });
  });
}

function forwardLines(child: ChildProcess, onOutput: (output: MpvInstallOutput) => void): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const readable = child[stream];
    if (!readable) {
      continue;
    }

    let buffer = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          onOutput({ line, stream });
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    readable.on("end", () => {
      if (buffer.trim().length > 0) {
        onOutput({ line: buffer.trim(), stream });
        buffer = "";
      }
    });
  }
}
