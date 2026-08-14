import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import type { MpvInstallCandidate } from "./install-catalog";
import { MpvInstaller } from "./mpv-installer";

const candidate: MpvInstallCandidate = {
  args: ["install", "mpv"],
  managerPath: "/opt/homebrew/bin/brew",
  option: { automatic: true, command: "brew install mpv", method: "brew", note: null, url: null },
};

function childProcess() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe("MpvInstaller", () => {
  it("rejects manual and overlapping installs without spawning twice", async () => {
    const child = childProcess();
    const spawn = vi.fn(() => child);
    const installer = new MpvInstaller({ spawn: spawn as never });
    await expect(installer.install({ ...candidate, managerPath: null, option: { ...candidate.option, automatic: false } }, vi.fn())).resolves.toEqual({
      error: "brew install mpv has to be run manually.",
      ok: false,
    });
    const first = installer.install(candidate, vi.fn());
    await expect(installer.install(candidate, vi.fn())).resolves.toEqual({ error: "Another install is already running.", ok: false });
    expect(spawn).toHaveBeenCalledOnce();
    child.emit("close", 0, null);
    await expect(first).resolves.toEqual({ ok: true });
  });

  it("streams complete lines and publishes success", async () => {
    const child = childProcess();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const spawn = vi.fn((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      spawnedEnv = options.env;
      return child;
    });
    const output: unknown[] = [];
    const installer = new MpvInstaller({ env: { PATH: "/custom" }, spawn: spawn as never });
    const result = installer.install(candidate, (line) => output.push(line));
    child.stdout!.emit("data", "one\ntw");
    child.stdout!.emit("data", "o\n");
    child.stderr!.emit("data", "warn\n");
    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ ok: true });
    expect(output).toEqual([
      { line: "$ brew install mpv", stream: "stdout" },
      { line: "one", stream: "stdout" },
      { line: "two", stream: "stdout" },
      { line: "warn", stream: "stderr" },
    ]);
    expect(installer.store.state).toEqual({ command: "brew install mpv", method: "brew", status: "succeeded" });
    expect(spawnedEnv).toMatchObject({ HOMEBREW_NO_AUTO_UPDATE: "1", NONINTERACTIVE: "1" });
  });

  it("cancels the running process and resolves it as failed", async () => {
    const child = childProcess();
    const installer = new MpvInstaller({ spawn: (() => child) as never });
    const result = installer.install(candidate, vi.fn());
    installer.cancel();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await expect(result).resolves.toEqual({ error: "Install cancelled.", ok: false });
    expect(installer.store.state).toMatchObject({ error: "Install cancelled.", status: "failed" });
  });
});
