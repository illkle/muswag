import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@tanstack/react-store";
import { describe, expect, it, vi } from "vitest";

import type { MpvInstallState, MpvState, PlayQueueInput } from "../../shared/player";
import type { MpvInstallCandidate } from "./binary/install-catalog";
import { MpvBinaryManager } from "./binary/mpv-binary-manager";
import { MpvInstaller } from "./binary/mpv-installer";
import { MpvBinaryMissingError } from "./errors";
import { MpvClient, type MpvClientEvent } from "./mpv/mpv-client";
import { Player } from "./player";

const tracks: PlayQueueInput["queue"] = [
  { id: "one", isDir: false, title: "One", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 180, discNumber: 1, track: 1 },
  { id: "two", isDir: false, title: "Two", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 200, discNumber: 1, track: 2 },
];

function setup(loadFile?: (url: string) => Promise<void>) {
  const calls: string[] = [];
  const listeners = new Set<(event: MpvClientEvent) => void>();
  const client = {
    dispose: vi.fn(),
    loadFile: vi.fn(async (url: string) => {
      calls.push(`load:${url}`);
      await loadFile?.(url);
    }),
    seek: vi.fn(async (position: number) => {
      calls.push(`seek:${position}`);
    }),
    setMuted: vi.fn(async (muted: boolean) => {
      calls.push(`mute:${muted}`);
    }),
    setPause: vi.fn(async (paused: boolean) => {
      calls.push(`pause:${paused}`);
    }),
    setVolume: vi.fn(async (volume: number) => {
      calls.push(`volume:${volume}`);
    }),
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
    subscribe(listener: (event: MpvClientEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const ready: MpvState = { binaryPath: "/mpv", source: "manual", status: "ready", version: "1" };
  const binaryStore = createStore<MpvState>(ready);
  const binaries = {
    binaryPath: "/mpv",
    clearManualPath: vi.fn(async () => ready),
    invalidate: vi.fn(async () => ready),
    refresh: vi.fn(async () => ready),
    setManualPath: vi.fn(async () => ready),
    store: binaryStore,
  };
  const installerStore = createStore<MpvInstallState>({ status: "idle" });
  const installer = {
    cancel: vi.fn(),
    fail: vi.fn((candidate: Pick<MpvInstallCandidate, "option">, error: string) => {
      installerStore.setState(() => ({
        command: candidate.option.command,
        error,
        method: candidate.option.method,
        status: "failed",
      }));
      return { error, ok: false as const };
    }),
    install: vi.fn(),
    store: installerStore,
  };
  const root = mkdtempSync(join(tmpdir(), "muswag-player-"));
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
    binaries,
    calls,
    client,
    emit(event: MpvClientEvent) {
      for (const listener of listeners) listener(event);
    },
    installer,
    player,
  };
}

describe("Player", () => {
  it("loads tracks with volume and mute first and preserves paused intent across next", async () => {
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks, startIndex: 0 });
    expect(calls).toEqual(["volume:100", "mute:false", "pause:false", "load:url:one"]);
    emit({ type: "file-loaded" });
    await player.pause();
    expect(player.getState().nowPlaying.status).toBe("paused");
    calls.length = 0;
    await player.next();
    expect(calls).toEqual(["volume:100", "mute:false", "load:url:two"]);
    emit({ type: "pause-change", paused: false });
    expect(player.getState().nowPlaying.status).toBe("loading");
    emit({ type: "file-loaded" });
    expect(player.getState().nowPlaying.status).toBe("paused");
  });

  it("restarts previous, auto-advances EOF, ignores other endings, and reloads ended tracks", async () => {
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks, startIndex: 0 });
    emit({ type: "file-loaded" });
    emit({ positionSeconds: 6, type: "time-pos-change" });
    calls.length = 0;
    await player.previous();
    expect(calls).toEqual(["seek:0"]);
    emit({ reason: "stop", type: "end-file" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(player.getState().queue.currentIndex).toBe(0);
    emit({ reason: "eof", type: "end-file" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(player.getState().queue.currentIndex).toBe(1);
    emit({ type: "file-loaded" });
    emit({ reason: "eof", type: "end-file" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(player.getState().nowPlaying.status).toBe("ended");
    calls.length = 0;
    await player.play();
    expect(calls.at(-1)).toBe("load:url:two");
    expect(player.getState().nowPlaying).toMatchObject({ positionSeconds: 0, status: "loading" });
  });

  it("serializes a slow load before a following next action", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const { calls, player } = setup(async () => {
      if (loads++ === 0) await gate;
    });
    const play = player.playQueue({ queue: tracks, startIndex: 0 });
    const next = player.next();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((call) => call.startsWith("load:"))).toEqual(["load:url:one"]);
    release();
    await Promise.all([play, next]);
    expect(calls.filter((call) => call.startsWith("load:"))).toEqual(["load:url:one", "load:url:two"]);
  });

  it("marks failures, re-resolves missing binaries, and keeps later operations usable", async () => {
    const { binaries, client, player } = setup();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.loadFile.mockRejectedValueOnce(new MpvBinaryMissingError("/mpv"));
    await player.playQueue({ queue: tracks, startIndex: 0 });
    expect(player.getState().nowPlaying).toMatchObject({ status: "error" });
    expect(binaries.invalidate).toHaveBeenCalledTimes(1);
    await player.next();
    expect(player.getState().queue.currentIndex).toBe(1);
    errorLog.mockRestore();
  });

  it("does not re-scan when playback is attempted while mpv is already missing", async () => {
    const { binaries, player } = setup();
    binaries.store.setState(() => ({ checkedPaths: ["mpv"], installOptions: [], status: "missing" }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await player.playQueue({ queue: tracks, startIndex: 0 });

    expect(player.getState().nowPlaying.status).toBe("error");
    expect(binaries.invalidate).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("publishes an unknown install method through the installer API", async () => {
    const { installer, player } = setup();

    await player.installMpv("apt", vi.fn());

    expect(installer.fail).toHaveBeenCalledWith({ option: { automatic: false, command: "apt", method: "apt", note: null, url: null } }, "apt is not available on this machine.");
    expect(player.getState().meta.mpvInstall).toMatchObject({ method: "apt", status: "failed" });
  });

  it("stops and clears an empty queue and no-ops track controls afterward", async () => {
    const { client, player } = setup();
    await player.playQueue({ queue: tracks, startIndex: 0 });
    await player.playQueue({ queue: [], startIndex: 0 });
    await player.play();
    await player.pause();
    await player.seek(2);
    expect(client.stop).toHaveBeenCalledOnce();
    expect(player.getState().queue.currentTrackId).toBeNull();
  });
});
