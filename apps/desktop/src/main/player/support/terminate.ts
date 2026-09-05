import type { ChildProcess } from "node:child_process";
import { Effect } from "effect";
import { runCommand } from "./exec";

/** Installer children are spawned in their own Unix process group. */
export const terminateInstaller = (child: ChildProcess, signal: "SIGTERM" | "SIGKILL") => {
  if (process.platform === "win32" && child.pid) {
    return runCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { timeoutMs: 1000 }).pipe(Effect.asVoid);
  }
  return Effect.sync(() => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* An already reaped process group needs no termination. */
    }
  });
};
