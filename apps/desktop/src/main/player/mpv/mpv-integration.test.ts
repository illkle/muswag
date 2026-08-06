import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@tanstack/react-store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MpvInstallState, MpvState, PlayQueueInput } from "../../../shared/player";
import { MpvBinaryManager } from "../binary/mpv-binary-manager";
import { MpvInstaller } from "../binary/mpv-installer";
import { Player } from "../player";
import { MpvClient } from "./mpv-client";

const integration = describe.runIf(process.env.MUSWAG_MPV_INTEGRATION === "1");
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

integration("real mpv playlist transitions", () => {
  it("plays a three-track queue through command-returned entry IDs", async () => {
    const audio = [createWave(440), createWave(550), createWave(660)];
    const server = await listen((request, response) => {
      const index = Number(request.url?.slice(1)) - 1;
      const body = audio[index];
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Length": body.length, "Content-Type": "audio/wav" });
      response.end(body);
    });
    const player = createRealPlayer(server);
    const append = vi.spyOn(player.client, "appendFile");
    const load = vi.spyOn(player.client, "loadFile");

    await player.player.playQueue({ queue: queue(3), startIndex: 0 });
    await waitFor(() => player.player.getState().nowPlaying.status === "ended");

    expect(player.player.getState().queue.currentTrackId).toBe("3");
    expect(load).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("retries a failing prefetched entry once and then reports the media error", async () => {
    const body = createWave(440);
    const server = await listen((request, response) => {
      if (request.url === "/1") {
        response.writeHead(200, { "Content-Length": body.length, "Content-Type": "audio/wav" });
        response.end(body);
        return;
      }
      response.writeHead(500).end();
    });
    const player = createRealPlayer(server);
    const load = vi.spyOn(player.client, "loadFile");
    const stop = vi.spyOn(player.client, "stop");

    await player.player.playQueue({ queue: queue(2), startIndex: 0 });
    await waitFor(() => player.player.getState().nowPlaying.status === "error");

    expect(player.player.getState().queue.currentTrackId).toBe("2");
    expect(load).toHaveBeenCalledTimes(2);
    expect(player.player.getState().nowPlaying.error).toBeTruthy();
    await waitFor(() => stop.mock.calls.length === 1);
    await stop.mock.results[0]?.value;
  }, 15_000);
});

function createRealPlayer(server: Server): { client: MpvClient; player: Player } {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server has no TCP address");
  const root = mkdtempSync(join(tmpdir(), "muswag-mpv-integration-"));
  const client = new MpvClient({
    extraArgs: ["--ao=null", "--no-config"],
    getBinaryPath: () => process.env.MUSWAG_MPV_PATH ?? "mpv",
    ipcPath: join(root, "mpv.sock"),
  });
  const ready: MpvState = { binaryPath: process.env.MUSWAG_MPV_PATH ?? "mpv", source: "path", status: "ready", version: "integration" };
  const binaries = {
    binaryPath: ready.binaryPath,
    clearManualPath: vi.fn(async () => ready),
    invalidate: vi.fn(async () => ready),
    refresh: vi.fn(async () => ready),
    setManualPath: vi.fn(async () => ready),
    store: createStore<MpvState>(ready),
  };
  const installer = { cancel: vi.fn(), fail: vi.fn(), install: vi.fn(), store: createStore<MpvInstallState>({ status: "idle" }) };
  const player = new Player(
    { ipcPath: join(root, "unused.sock"), mpvPathStatePath: join(root, "mpv.json"), volumeStatePath: join(root, "volume.json") },
    {
      binaries: binaries as unknown as MpvBinaryManager,
      client,
      detectInstallCandidates: async () => [],
      installer: installer as unknown as MpvInstaller,
      resolveStreamUrl: (_credentials, id) => `http://127.0.0.1:${address.port}/${id}`,
    },
  );
  cleanup.push(() => player.dispose());
  return { client, player };
}

function queue(count: number): PlayQueueInput["queue"] {
  return Array.from({ length: count }, (_, index) => ({ id: String(index + 1), isDir: false, title: `Track ${index + 1}`, duration: 0.25 }));
}

function createWave(frequency: number): Buffer {
  const sampleRate = 44_100;
  const sampleCount = Math.floor(sampleRate / 4);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin((index * frequency * Math.PI * 2) / sampleRate) * 8_000), 44 + index * 2);
  }
  return buffer;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return server;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for real mpv playback state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
