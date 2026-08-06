import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@tanstack/react-store";
import { describe, expect, it, vi } from "vitest";

import type { UserCredentialsToLogin } from "@muswag/shared";
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
  { id: "three", isDir: false, title: "Three", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 220, discNumber: 1, track: 3 },
  { id: "four", isDir: false, title: "Four", albumId: "a", album: "A", artist: "Artist", displayArtist: "Artist", duration: 240, discNumber: 1, track: 4 },
];

type SetupOptions = {
  appendFile?: (url: string) => Promise<number>;
  loadFile?: (url: string) => Promise<number>;
  resolveStreamUrl?: (credentials: UserCredentialsToLogin | null, id: string) => string;
};

function setup(options: SetupOptions = {}) {
  const calls: string[] = [];
  const listeners = new Set<(event: MpvClientEvent) => void>();
  let nextEntryId = 1;
  const client = {
    state: "ready" as "stopped" | "starting" | "ready",
    appendFile: vi.fn(async (url: string) => {
      calls.push(`append:${url}`);
      return options.appendFile ? options.appendFile(url) : nextEntryId++;
    }),
    clearPlaylistExceptCurrent: vi.fn(async () => {
      calls.push("playlist-clear");
    }),
    dispose: vi.fn(),
    loadFile: vi.fn(async (url: string) => {
      calls.push(`load:${url}`);
      return options.loadFile ? options.loadFile(url) : nextEntryId++;
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
  const binaries = {
    binaryPath: "/mpv",
    clearManualPath: vi.fn(async () => ready),
    invalidate: vi.fn(async () => ready),
    refresh: vi.fn(async () => ready),
    setManualPath: vi.fn(async () => ready),
    store: createStore<MpvState>(ready),
  };
  const installerStore = createStore<MpvInstallState>({ status: "idle" });
  const installer = {
    cancel: vi.fn(),
    fail: vi.fn((candidate: Pick<MpvInstallCandidate, "option">, error: string) => {
      installerStore.setState(() => ({ command: candidate.option.command, error, method: candidate.option.method, status: "failed" }));
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
      resolveStreamUrl: options.resolveStreamUrl ?? ((_credentials, id) => `url:${id}`),
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

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function start(emit: (event: MpvClientEvent) => void, entryId: number): void {
  emit({ playlistEntryId: entryId, type: "start-file" });
}

function end(emit: (event: MpvClientEvent) => void, entryId: number, reason: "eof" | "error" | "stop", fileError: string | null = null): void {
  emit({ fileError, playlistEntryId: entryId, reason, type: "end-file" });
}

describe("Player", () => {
  it("loads the selected track and appends exactly one lookahead after file-loaded", async () => {
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    expect(calls).toEqual(["volume:100", "mute:false", "pause:false", "load:url:one"]);

    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();

    expect(player.getState().nowPlaying.status).toBe("playing");
    expect(calls.filter((call) => call === "append:url:two")).toHaveLength(1);
  });

  it("auto-advances through lookaheads without replace loads and ends the final track", async () => {
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 3), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    calls.length = 0;

    end(emit, 1, "eof");
    start(emit, 2);
    expect(player.getState()).toMatchObject({ nowPlaying: { positionSeconds: 0, status: "loading" }, queue: { currentTrackId: "two" } });
    emit({ type: "file-loaded" });
    await flush();
    expect(calls).toEqual(["append:url:three"]);

    end(emit, 2, "eof");
    start(emit, 3);
    emit({ type: "file-loaded" });
    await flush();
    expect(calls.filter((call) => call.startsWith("load:"))).toHaveLength(0);
    end(emit, 3, "eof");
    await flush();
    expect(player.getState().nowPlaying).toMatchObject({ positionSeconds: 220, status: "ended" });
  });

  it("ignores unavailable position and duration properties while mpv unloads the old entry", async () => {
    const { emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    emit({ durationSeconds: 290.311837, type: "duration-change" });
    emit({ positionSeconds: 289.67145, type: "time-pos-change" });

    emit({ durationSeconds: null, type: "duration-change" });
    emit({ positionSeconds: null, type: "time-pos-change" });
    expect(player.getState().nowPlaying).toMatchObject({ durationSeconds: 290.311837, positionSeconds: 289.67145, status: "playing" });

    end(emit, 1, "eof");
    start(emit, 2);
    expect(player.getState()).toMatchObject({ nowPlaying: { durationSeconds: 200, positionSeconds: 0, status: "loading" }, queue: { currentTrackId: "two" } });
  });

  it("buffers lifecycle events until an append response records its entry ID", async () => {
    let release!: (entryId: number) => void;
    const appendGate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const { emit, player } = setup({ appendFile: async () => appendGate });
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();

    end(emit, 1, "eof");
    start(emit, 2);
    expect(player.getState().queue.currentTrackId).toBe("one");
    release(2);
    await flush();
    expect(player.getState()).toMatchObject({ nowPlaying: { status: "loading" }, queue: { currentTrackId: "two" } });
  });

  it("falls back to an explicit load when lookahead append fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, emit, player } = setup({ appendFile: async () => Promise.reject(new Error("append failed")) });
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    end(emit, 1, "eof");
    await flush();
    expect(calls.filter((call) => call === "load:url:two")).toHaveLength(1);
    expect(player.getState().nowPlaying.status).toBe("loading");
    errorLog.mockRestore();
  });

  it("retries a failed prefetched entry once while preserving pause intent", async () => {
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    await player.pause();
    calls.length = 0;

    end(emit, 1, "eof");
    start(emit, 2);
    end(emit, 2, "error", "network error");
    await flush();

    expect(calls).toEqual(["volume:100", "mute:false", "load:url:two"]);
    start(emit, 3);
    emit({ type: "file-loaded" });
    await flush();
    expect(player.getState().nowPlaying.status).toBe("paused");
  });

  it("stops after a second recovery failure", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    end(emit, 1, "eof");
    start(emit, 2);
    end(emit, 2, "error", "first failure");
    await flush();
    start(emit, 3);
    end(emit, 3, "error", "second failure");
    await flush();
    expect(player.getState().nowPlaying).toMatchObject({ error: "second failure", status: "error" });
    expect(calls).toContain("stop");
    errorLog.mockRestore();
  });

  it("stops active-track errors so a former lookahead cannot become ghost playback", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { calls, emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();

    end(emit, 1, "error", "connection lost");
    start(emit, 2);
    emit({ type: "file-loaded" });
    await flush();

    expect(player.getState()).toMatchObject({ nowPlaying: { error: "connection lost", status: "error" }, queue: { currentTrackId: "one" } });
    expect(calls).toContain("stop");
    errorLog.mockRestore();
  });

  it("serializes credential invalidation behind an in-flight append", async () => {
    let release!: (entryId: number) => void;
    const appendGate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const resolveStreamUrl = (credentials: UserCredentialsToLogin | null, id: string) => {
      if (!credentials) throw new Error("Login required");
      return `${credentials.username}:${id}`;
    };
    const { calls, emit, player } = setup({ appendFile: async () => appendGate, resolveStreamUrl });
    const oldCredentials = { password: "old", url: "https://old", username: "old" };
    const newCredentials = { password: "new", url: "https://new", username: "new" };
    await player.setCredentials(oldCredentials);
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();

    const changingCredentials = player.setCredentials(newCredentials);
    release(2);
    await changingCredentials;
    expect(calls.slice(-2)).toEqual(["append:old:two", "playlist-clear"]);

    end(emit, 1, "eof");
    await flush();
    expect(calls).toContain("load:new:two");
  });

  it("replace-loads the invalidated lookahead when credentials change during the EOF boundary", async () => {
    const resolveStreamUrl = (credentials: UserCredentialsToLogin | null, id: string) => `${credentials?.username ?? "none"}:${id}`;
    const { calls, emit, player } = setup({ resolveStreamUrl });
    await player.setCredentials({ password: "old", url: "https://old", username: "old" });
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();

    end(emit, 1, "eof");
    await player.setCredentials({ password: "new", url: "https://new", username: "new" });

    expect(calls.slice(-5)).toEqual(["playlist-clear", "volume:100", "mute:false", "pause:false", "load:new:two"]);
    expect(player.getState()).toMatchObject({ nowPlaying: { status: "loading" }, queue: { currentTrackId: "two" } });
    start(emit, 2);
    expect(player.getState().nowPlaying.status).toBe("loading");
  });

  it("does not spawn mpv for credentials while stopped and no-ops identical values", async () => {
    const { client, emit, player } = setup();
    client.state = "stopped";
    const credentials = { password: "p", url: "https://server", username: "u" };
    await player.setCredentials(credentials);
    expect(client.clearPlaylistExceptCurrent).not.toHaveBeenCalled();

    client.state = "ready";
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    start(emit, 1);
    emit({ type: "file-loaded" });
    await flush();
    await player.setCredentials({ ...credentials });
    expect(client.clearPlaylistExceptCurrent).not.toHaveBeenCalled();
  });

  it("ignores stop endings and fails malformed correlated lifecycle events", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { emit, player } = setup();
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    end(emit, 1, "stop");
    expect(player.getState().nowPlaying.status).toBe("loading");
    emit({ playlistEntryId: null, type: "start-file" });
    await flush();
    expect(player.getState().nowPlaying).toMatchObject({ error: expect.stringContaining("0.33.0"), status: "error" });
    errorLog.mockRestore();
  });

  it("serializes a slow load before a following next action", async () => {
    let release!: (entryId: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const { calls, player } = setup({ loadFile: async () => (loads++ === 0 ? gate : 2) });
    const play = player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    const next = player.next();
    await flush();
    expect(calls.filter((call) => call.startsWith("load:"))).toEqual(["load:url:one"]);
    release(1);
    await Promise.all([play, next]);
    expect(calls.filter((call) => call.startsWith("load:"))).toEqual(["load:url:one", "load:url:two"]);
  });

  it("marks failures, re-resolves missing binaries, and keeps later operations usable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { binaries, client, player } = setup();
    client.loadFile.mockRejectedValueOnce(new MpvBinaryMissingError("/mpv"));
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    expect(player.getState().nowPlaying.status).toBe("error");
    expect(binaries.invalidate).toHaveBeenCalledTimes(1);
    await player.next();
    expect(player.getState().queue.currentIndex).toBe(1);
    errorLog.mockRestore();
  });

  it("does not re-scan when playback is attempted while mpv is already missing", async () => {
    const { binaries, player } = setup();
    binaries.store.setState(() => ({ checkedPaths: ["mpv"], installOptions: [], status: "missing" }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
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
    await player.playQueue({ queue: tracks.slice(0, 2), startIndex: 0 });
    await player.playQueue({ queue: [], startIndex: 0 });
    await player.play();
    await player.pause();
    await player.seek(2);
    expect(client.stop).toHaveBeenCalled();
    expect(player.getState().queue.currentTrackId).toBeNull();
  });
});
