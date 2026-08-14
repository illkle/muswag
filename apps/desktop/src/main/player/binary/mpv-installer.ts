import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import { createStore } from "@tanstack/react-store";

import type { MpvInstallState } from "#shared/player";
import type { MpvInstallCandidate } from "./install-catalog";
import { getManagerBinDirectory } from "./install-catalog";
import { createLineSplitter } from "../support/line-splitter";

export type MpvInstallOutput = { line: string; stream: "stdout" | "stderr" };
export type MpvInstallResult = { ok: true } | { ok: false; error: string };

export class MpvInstaller {
  readonly store = createStore<MpvInstallState>({ status: "idle" });

  private readonly spawnProcess: typeof spawn;
  private readonly env: NodeJS.ProcessEnv;
  private running: ChildProcess | undefined;
  private cancelled = false;

  constructor(deps: { spawn?: typeof spawn; env?: NodeJS.ProcessEnv } = {}) {
    this.spawnProcess = deps.spawn ?? spawn;
    this.env = deps.env ?? process.env;
  }

  install(candidate: MpvInstallCandidate, onOutput: (output: MpvInstallOutput) => void): Promise<MpvInstallResult> {
    if (!candidate.option.automatic || !candidate.managerPath) {
      return Promise.resolve(this.publishFailure(candidate, `${candidate.option.command} has to be run manually.`));
    }
    if (this.running) {
      return Promise.resolve({ error: "Another install is already running.", ok: false });
    }

    this.store.setState(() => ({ command: candidate.option.command, method: candidate.option.method, status: "running" }));
    onOutput({ line: `$ ${candidate.option.command}`, stream: "stdout" });
    this.cancelled = false;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: MpvInstallResult) => {
        if (settled) return;
        settled = true;
        this.running = undefined;
        this.store.setState(() =>
          result.ok
            ? { command: candidate.option.command, method: candidate.option.method, status: "succeeded" }
            : { command: candidate.option.command, error: result.error, method: candidate.option.method, status: "failed" },
        );
        resolve(result);
      };

      let child: ChildProcess;
      try {
        child = this.spawnProcess(candidate.managerPath!, candidate.args, {
          env: {
            ...this.env,
            PATH: [getManagerBinDirectory(candidate.managerPath!), this.env.PATH, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(delimiter),
            HOMEBREW_COLOR: "0",
            HOMEBREW_NO_ANALYTICS: "1",
            HOMEBREW_NO_AUTO_UPDATE: "1",
            HOMEBREW_NO_ENV_HINTS: "1",
            NONINTERACTIVE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        finish({ error: cause instanceof Error ? cause.message : String(cause), ok: false });
        return;
      }

      this.running = child;
      for (const stream of ["stdout", "stderr"] as const) {
        const readable = child[stream];
        if (!readable) continue;
        const splitter = createLineSplitter((line) => onOutput({ line, stream }));
        readable.setEncoding("utf8");
        readable.on("data", (chunk: string) => splitter.push(chunk));
        readable.on("end", () => splitter.flush());
      }
      child.on("error", (cause: Error) => finish({ error: cause.message, ok: false }));
      child.on("close", (code, signal) => {
        if (this.cancelled) finish({ error: "Install cancelled.", ok: false });
        else if (code === 0) finish({ ok: true });
        else
          finish({
            error: signal ? `${candidate.option.command} was terminated (${signal}).` : `${candidate.option.command} exited with code ${code}.`,
            ok: false,
          });
      });
    });
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.running.kill("SIGTERM");
  }

  fail(candidate: Pick<MpvInstallCandidate, "option">, error: string): MpvInstallResult {
    return this.publishFailure(candidate, error);
  }

  private publishFailure(candidate: Pick<MpvInstallCandidate, "option">, error: string): MpvInstallResult {
    this.store.setState(() => ({ command: candidate.option.command, error, method: candidate.option.method, status: "failed" }));
    return { error, ok: false };
  }
}
