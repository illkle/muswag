import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

import { MpvBinaryMissingError } from "../errors";
import { MpvClient } from "./mpv-client";

class FakeSocket extends Duplex {
  readonly commands: Array<Record<string, unknown>> = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const payload = JSON.parse(chunk.toString()) as Record<string, unknown>;
    this.commands.push(payload);
    const requestId = payload.request_id;
    if (typeof requestId === "number") queueMicrotask(() => this.push(`${JSON.stringify({ error: "success", request_id: requestId })}\n`));
    callback();
  }
}

function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  let killed = false;
  Object.defineProperty(child, "killed", { get: () => killed });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}

describe("MpvClient", () => {
  it("spawns once, observes properties, matches responses, and forwards events", async () => {
    const socket = new FakeSocket();
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const client = new MpvClient(
      { getBinaryPath: () => "/mpv", ipcPath: "/tmp/mpv.sock" },
      { connect: async () => socket as unknown as Socket, platform: "linux", removeSocketFile: vi.fn(), spawn: spawn as never },
    );
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    await Promise.all([client.setPause(false), client.setMuted(true)]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(socket.commands.slice(0, 5).map((payload) => payload.command)).toEqual([
      ["observe_property", 1, "pause"],
      ["observe_property", 2, "time-pos"],
      ["observe_property", 3, "duration"],
      ["observe_property", 4, "volume"],
      ["observe_property", 5, "mute"],
    ]);
    socket.push('{"event":"property-change","name":"pause","data":true}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toContainEqual({ paused: true, type: "pause-change" });
    child.emit("exit", 2, null);
    expect(client.state).toBe("stopped");
    expect(events).toContainEqual({ expected: false, type: "exited" });
  });

  it("maps spawn ENOENT to MpvBinaryMissingError and does not spawn without a path", async () => {
    const child = fakeChild();
    const client = new MpvClient(
      { getBinaryPath: () => "/gone", ipcPath: "/tmp/mpv.sock" },
      {
        connect: () => new Promise(() => undefined),
        platform: "win32",
        removeSocketFile: vi.fn(),
        spawn: (() => {
          queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
          return child;
        }) as never,
      },
    );
    await expect(client.setPause(false)).rejects.toBeInstanceOf(MpvBinaryMissingError);

    const unavailable = new MpvClient({ getBinaryPath: () => null, ipcPath: "pipe" }, { spawn: vi.fn() as never });
    await expect(unavailable.setPause(false)).rejects.toThrow("No usable mpv binary");
  });

  it("reports an unexpected exit when the socket closes before the child exits", async () => {
    const socket = new FakeSocket();
    const child = fakeChild();
    const client = new MpvClient(
      { getBinaryPath: () => "/mpv", ipcPath: "/tmp/mpv.sock" },
      {
        connect: async () => socket as unknown as Socket,
        platform: "linux",
        removeSocketFile: vi.fn(),
        spawn: (() => child) as never,
      },
    );
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event));
    await client.setPause(false);

    socket.emit("close");
    child.emit("exit", 2, null);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(events.filter((event) => (event as { type?: string }).type === "exited")).toEqual([{ expected: false, type: "exited" }]);
  });

  it("disposes silently and rejects subsequent commands", async () => {
    const socket = new FakeSocket();
    const child = fakeChild();
    const remove = vi.fn();
    const client = new MpvClient(
      { getBinaryPath: () => "/mpv", ipcPath: "/tmp/mpv.sock" },
      { connect: async () => socket as unknown as Socket, platform: "linux", removeSocketFile: remove, spawn: (() => child) as never },
    );
    await client.setPause(false);
    client.dispose();
    expect(child.kill).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(2);
    await expect(client.setPause(true)).rejects.toThrow("disposed");
  });
});
