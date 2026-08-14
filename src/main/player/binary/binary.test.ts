import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandResult } from "../support/exec";
import { MpvBinaryManager } from "./mpv-binary-manager";
import { collectMpvCandidates, getWellKnownMpvPaths, type MpvLocatorDeps } from "./mpv-locator";
import { validateMpvBinary } from "./mpv-validator";

function result(patch: Partial<CommandResult> = {}): CommandResult {
  return { code: 0, errorCode: null, stderr: "", stdout: "", ...patch };
}

function deps(overrides: Partial<MpvLocatorDeps> = {}): MpvLocatorDeps {
  return {
    env: {},
    fileExists: async () => false,
    homeDirectory: "/home/test",
    platform: "linux",
    runCommand: async () => result({ code: 1 }),
    ...overrides,
  };
}

describe("mpv discovery and validation", () => {
  it("checks WinGet's command alias and installed-app paths on Windows", () => {
    const paths = getWellKnownMpvPaths(
      deps({
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "D:\\Programs", USERPROFILE: "C:\\Users\\me" },
        platform: "win32",
      }),
    );

    expect(paths).toContain("C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\mpv.exe");
    expect(paths).toContain("D:\\Programs\\MPV Player\\mpv.exe");
  });

  it("collects explicit, cached, PATH, well-known, then login-shell candidates", async () => {
    const candidates = await collectMpvCandidates(
      { cachedPath: " /cached ", manualPath: "/manual" },
      deps({
        env: { MUSWAG_MPV_PATH: "/env", SHELL: "/bin/zsh" },
        fileExists: async (path) => path === "/usr/bin/mpv",
        runCommand: async () => result({ stdout: "banner\n/login/mpv\n" }),
      }),
    );
    expect(candidates).toEqual([
      { binaryPath: "/env", explicit: true, source: "env" },
      { binaryPath: "/manual", explicit: true, source: "manual" },
      { binaryPath: "/cached", explicit: false, source: "cache" },
      { binaryPath: "mpv", explicit: false, source: "path" },
      { binaryPath: "/usr/bin/mpv", explicit: false, source: "well-known" },
      { binaryPath: "/login/mpv", explicit: false, source: "login-shell" },
    ]);
  });

  it("interprets versions and spawn errors", async () => {
    await expect(validateMpvBinary("mpv", deps({ runCommand: async () => result({ stdout: "mpv v0.41.0 Copyright" }) }))).resolves.toEqual({ ok: true, version: "0.41.0" });
    await expect(validateMpvBinary("mpv", deps({ runCommand: async () => result({ stdout: "mpv 0.41.0-449-g1234567" }) }))).resolves.toEqual({
      ok: true,
      version: "0.41.0-449-g1234567",
    });
    await expect(validateMpvBinary("mpv", deps({ runCommand: async () => result({ stdout: "mpv 0.40.0" }) }))).resolves.toMatchObject({
      missing: false,
      ok: false,
      reason: expect.stringContaining("0.41.0"),
    });
    await expect(validateMpvBinary("mpv", deps({ runCommand: async () => result({ stdout: "not mpv" }) }))).resolves.toMatchObject({
      missing: false,
      ok: false,
      reason: expect.stringContaining("could not be parsed"),
    });
    await expect(validateMpvBinary("mpv", deps({ runCommand: async () => result({ code: null, errorCode: "EACCES" }) }))).resolves.toEqual({
      missing: false,
      ok: false,
      reason: "The file is not executable.",
    });
  });
});

describe("MpvBinaryManager", () => {
  it("shares refresh work, picks the first valid candidate, and caches only absolute paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "muswag-binary-"));
    const statePath = join(root, "mpv.json");
    let probes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new MpvBinaryManager(
      { statePath },
      deps({
        env: { MUSWAG_MPV_PATH: "/valid", SHELL: "/bin/sh" },
        runCommand: async (command) => {
          if (command === "/bin/sh") return result({ code: 1 });
          probes += 1;
          await gate;
          return result({ stdout: "mpv 1.2.3" });
        },
      }),
    );
    const first = manager.refresh();
    const second = manager.refresh();
    expect(first).toBe(second);
    release();
    await expect(first).resolves.toEqual({ binaryPath: "/valid", source: "env", status: "ready", version: "1.2.3" });
    expect(probes).toBe(1);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ cachedPath: "/valid", manualPath: null });
  });

  it("retains the last resolved binary path while a refresh is checking", async () => {
    const root = mkdtempSync(join(tmpdir(), "muswag-binary-"));
    let probe = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new MpvBinaryManager(
      { statePath: join(root, "mpv.json") },
      deps({
        env: { MUSWAG_MPV_PATH: "/valid", SHELL: "/bin/sh" },
        runCommand: async (command) => {
          if (command === "/bin/sh") return result({ code: 1 });
          probe += 1;
          if (probe === 2) await gate;
          return result({ stdout: "mpv 1.2.3" });
        },
      }),
    );
    await manager.refresh();
    const refresh = manager.refresh();

    expect(manager.store.state).toEqual({ status: "checking" });
    expect(manager.binaryPath).toBe("/valid");

    release();
    await refresh;
    expect(manager.binaryPath).toBe("/valid");
  });

  it("reports a broken manual path but silently skips a broken cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "muswag-binary-"));
    const make = (name: string) =>
      new MpvBinaryManager(
        { statePath: join(root, name) },
        deps({
          runCommand: async (command) => {
            if (command === "/manual") return result({ code: null, errorCode: "ENOENT" });
            if (command === "/cached") return result({ code: null, errorCode: "EACCES" });
            if (command === "mpv") return result({ stdout: "mpv 0.41.0" });
            return result({ code: 1 });
          },
        }),
      );
    await expect(make("manual.json").setManualPath("/manual")).resolves.toMatchObject({ binaryPath: "/manual", source: "manual", status: "invalid" });
    const cachedPath = join(root, "cached.json");
    const cached = make("cached.json");
    // Seed via the public persistence schema to exercise startup loading.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachedPath, JSON.stringify({ cachedPath: "/cached", manualPath: null }));
    const loaded = make("cached.json");
    await expect(loaded.refresh()).resolves.toMatchObject({ binaryPath: "mpv", source: "path", status: "ready" });
    expect(cached.binaryPath).toBeNull();
  });
});
