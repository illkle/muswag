import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@tanstack/react-store";
import { describe, expect, it, vi } from "vitest";

import type { MpvInstallState, MpvState, PlayerEvent } from "#shared/player";
import { MpvBinaryManager } from "./binary/mpv-binary-manager";
import { MpvInstaller } from "./binary/mpv-installer";
import { MpvClient, type MpvClientEvent } from "./mpv/mpv-client";
import { Player } from "./player";

function setup() {
  let nextId = 1;
  const listeners = new Set<(event: MpvClientEvent) => void>();
  const client = {
    state: "ready" as const,
    clearPlaylistExceptCurrent: vi.fn(async () => undefined),
    dispose: vi.fn(),
    insertFile: vi.fn(async () => nextId++),
    loadFile: vi.fn(async () => nextId++),
    playPlaylistIndex: vi.fn(async () => undefined),
    removePlaylistEntry: vi.fn(async () => undefined),
    seek: vi.fn(async () => undefined),
    setMuted: vi.fn(async () => undefined),
    setPause: vi.fn(async () => undefined),
    setVolume: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    subscribe(listener: (event: MpvClientEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const ready: MpvState = { binaryPath: "/mpv", source: "manual", status: "ready", version: "0.41.0" };
  const binaries = {
    binaryPath: "/mpv",
    clearManualPath: vi.fn(async () => ready),
    invalidate: vi.fn(async () => ready),
    refresh: vi.fn(async () => ready),
    setManualPath: vi.fn(async () => ready),
    store: createStore<MpvState>(ready),
  };
  const installer = { cancel: vi.fn(), fail: vi.fn(), install: vi.fn(), store: createStore<MpvInstallState>({ status: "idle" }) };
  const root = mkdtempSync(join(tmpdir(), "muswag-runtime-"));
  const player = new Player(
    { ipcPath: "ipc", mpvPathStatePath: join(root, "mpv.json"), volumeStatePath: join(root, "volume.json") },
    {
      binaries: binaries as unknown as MpvBinaryManager,
      client: client as unknown as MpvClient,
      detectInstallCandidates: async () => [],
      installer: installer as unknown as MpvInstaller,
      resolveStreamUrl: (_credentials, id) => `url:${id}`,
    },
  );
  return {
    client,
    player,
    emit(event: MpvClientEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Player runtime state", () => {
  it("publishes a correlated start atomically and applies the restore seek after file-loaded", async () => {
    const { client, emit, player } = setup();
    const events: PlayerEvent[] = [];
    player.subscribe((event) => events.push(event));
    const first = { key: "source:first", track: { id: "first", isDir: false, title: "First", duration: 180 } };
    const second = { key: "source:second", track: { id: "second", isDir: false, title: "Second", duration: 200 } };

    await player.applyQueue({ snapshot: { items: [first, second] }, select: { key: first.key, play: false, positionSeconds: 12 } });
    emit({ playlistEntryId: 999, type: "start-file" });
    expect(player.getState().runtime.current).toBeNull();
    emit({ playlistEntryId: 1, type: "start-file" });

    expect(player.getState().runtime).toMatchObject({ current: { key: first.key }, durationSeconds: 180, paused: true, positionSeconds: 12, status: "loading" });
    expect(events.at(-1)).toMatchObject({ type: "runtime", state: { current: { key: first.key }, positionSeconds: 12, status: "loading" } });

    emit({ type: "file-loaded" });
    await flush();
    expect(client.seek).toHaveBeenCalledWith(12);
    expect(player.getState().runtime.status).toBe("paused");
    player.dispose();
  });

  it("retries a loading media failure once and then stops with an error", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client, emit, player } = setup();
    const current = { key: "source:first", track: { id: "first", isDir: false, title: "First" } };
    await player.applyQueue({ snapshot: { items: [current] }, select: { key: current.key, play: true } });
    emit({ playlistEntryId: 1, type: "start-file" });
    emit({ fileError: "network", playlistEntryId: 1, reason: "error", type: "end-file" });
    await flush();
    expect(client.loadFile).toHaveBeenCalledTimes(2);

    emit({ playlistEntryId: 2, type: "start-file" });
    emit({ fileError: "network again", playlistEntryId: 2, reason: "error", type: "end-file" });
    await flush();
    expect(player.getState().runtime).toMatchObject({ error: "network again", status: "error" });
    expect(client.stop).toHaveBeenCalledOnce();
    errorLog.mockRestore();
    player.dispose();
  });

  it("forgets mirrored entries when mpv playlist clearing fails during stop", async () => {
    const { client, emit, player } = setup();
    const current = { key: "source:first", track: { id: "first", isDir: false, title: "First" } };
    await player.applyQueue({ snapshot: { items: [current] }, select: { key: current.key, play: true } });
    client.clearPlaylistExceptCurrent.mockRejectedValueOnce(new Error("mpv unavailable"));

    await expect(player.stop()).resolves.toBeUndefined();
    emit({ playlistEntryId: 1, type: "start-file" });

    expect(player.getState().runtime.current).toBeNull();
    player.dispose();
  });
});
