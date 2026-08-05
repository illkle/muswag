import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { MpvBinaryMissingError, MpvUnavailableError } from "../errors";
import { createLineSplitter } from "../support/line-splitter";
import { encodeCommand, OBSERVED_PROPERTIES, parseMpvMessage, type MpvEvent } from "./mpv-protocol";

const CONNECT_ATTEMPTS = 50;
const CONNECT_DELAY_MS = 100;

type CommandResolver = { resolve: (data: unknown) => void; reject: (cause: unknown) => void };

export type MpvClientEvent = MpvEvent | { type: "exited"; expected: boolean } | { type: "error"; cause: unknown };

export type MpvClientDeps = {
  spawn: typeof spawn;
  connect: (ipcPath: string) => Promise<Socket>;
  removeSocketFile: (ipcPath: string) => void;
  platform: NodeJS.Platform;
};

export class MpvClient {
  private readonly options: { ipcPath: string; getBinaryPath: () => string | null };
  private readonly deps: MpvClientDeps;
  private readonly listeners = new Set<(event: MpvClientEvent) => void>();
  private readonly pending = new Map<number, CommandResolver>();
  private process: ChildProcess | undefined;
  private socket: Socket | undefined;
  private startPromise: Promise<void> | undefined;
  private requestId = 1;
  private disposed = false;
  private lifecycleState: "stopped" | "starting" | "ready" = "stopped";

  constructor(options: { ipcPath: string; getBinaryPath: () => string | null }, deps: Partial<MpvClientDeps> = {}) {
    this.options = options;
    this.deps = {
      connect: deps.connect ?? connectSocket,
      platform: deps.platform ?? process.platform,
      removeSocketFile: deps.removeSocketFile ?? ((ipcPath) => rmSync(ipcPath, { force: true })),
      spawn: deps.spawn ?? spawn,
    };
  }

  get state(): "stopped" | "starting" | "ready" {
    return this.lifecycleState;
  }

  subscribe(listener: (event: MpvClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadFile(url: string): Promise<void> {
    await this.command(["loadfile", url, "replace"]);
  }

  async setPause(paused: boolean): Promise<void> {
    await this.command(["set_property", "pause", paused]);
  }

  async setVolume(volumePercent: number): Promise<void> {
    await this.command(["set_property", "volume", volumePercent]);
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.command(["set_property", "mute", muted]);
  }

  async seek(positionSeconds: number): Promise<void> {
    await this.command(["seek", positionSeconds, "absolute+exact"]);
  }

  async stop(): Promise<void> {
    if (this.disposed) throw new Error("mpv client has been disposed");
    if (this.lifecycleState === "stopped") return;
    await this.command(["stop"]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.startPromise = undefined;
    this.rejectPending(new Error("mpv client disposed"));

    const socket = this.socket;
    this.socket = undefined;
    if (socket && !socket.destroyed) {
      socket.write(encodeCommand(["quit"]));
      socket.end();
      socket.destroy();
    }
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.lifecycleState = "stopped";
    if (this.deps.platform !== "win32") this.deps.removeSocketFile(this.options.ipcPath);
  }

  private async command(command: unknown[]): Promise<unknown> {
    await this.ensureReady();
    return this.sendCommand(command);
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("mpv client has been disposed"));
    if (this.lifecycleState === "ready" && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.lifecycleState = "starting";
    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const binaryPath = this.options.getBinaryPath();
    if (!binaryPath) {
      this.lifecycleState = "stopped";
      throw new MpvUnavailableError("No usable mpv binary is configured.");
    }
    if (this.deps.platform !== "win32") this.deps.removeSocketFile(this.options.ipcPath);

    const args = ["--idle=yes", "--no-video", "--audio-display=no", "--force-window=no", "--terminal=no", `--input-ipc-server=${this.options.ipcPath}`];

    let child: ChildProcess;
    try {
      child = this.deps.spawn(binaryPath, args, { stdio: ["ignore", "ignore", "ignore"] });
    } catch (cause) {
      this.lifecycleState = "stopped";
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new MpvBinaryMissingError(binaryPath);
      throw cause;
    }
    this.process = child;
    child.on("exit", (code, signal) => this.handleExit(child, code, signal));

    try {
      const socket = await Promise.race([
        this.connectWithRetries(child),
        new Promise<never>((_, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => reject(new Error(`mpv exited before IPC was ready (${code ?? signal ?? "unknown"}).`)));
        }),
      ]);
      if (this.disposed) {
        socket.destroy();
        throw new Error("mpv client disposed while starting");
      }
      this.attachSocket(socket);
      await Promise.all(OBSERVED_PROPERTIES.map(([id, name]) => this.sendCommand(["observe_property", id, name])));
      if (this.process !== child || !this.socket) throw new Error("mpv stopped while starting");
      this.lifecycleState = "ready";
    } catch (cause) {
      if (this.process === child) {
        this.process = undefined;
        if (!child.killed) child.kill();
      }
      this.socket?.destroy();
      this.socket = undefined;
      this.rejectPending(cause);
      this.lifecycleState = "stopped";
      if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new MpvBinaryMissingError(binaryPath);
      throw cause;
    }
  }

  private async connectWithRetries(child: ChildProcess): Promise<Socket> {
    let lastCause: unknown = new Error("Timed out connecting to the mpv IPC server.");
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      try {
        return await this.deps.connect(this.options.ipcPath);
      } catch (cause) {
        lastCause = cause;
        if (this.process !== child || this.disposed) throw cause;
        if (attempt < CONNECT_ATTEMPTS - 1) await delay(CONNECT_DELAY_MS);
      }
    }
    throw lastCause;
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    const splitter = createLineSplitter((line) => this.handleLine(line));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => splitter.push(chunk));
    socket.on("end", () => splitter.flush());
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.disposed) return;
      this.lifecycleState = "stopped";
      this.rejectPending(new Error("mpv IPC connection closed"));
      const child = this.process;
      this.process = undefined;
      if (child && !child.killed) child.kill();
      this.emit({ expected: false, type: "exited" });
    });
    socket.on("error", (cause) => {
      if (!this.disposed) this.emit({ cause, type: "error" });
    });
  }

  private handleLine(line: string): void {
    const message = parseMpvMessage(line);
    if (!message) return;
    if (message.kind === "event") {
      this.emit(message.event);
      return;
    }
    const resolver = this.pending.get(message.requestId);
    if (!resolver) return;
    this.pending.delete(message.requestId);
    if (message.error) resolver.reject(new Error(message.error));
    else resolver.resolve(message.data);
  }

  private sendCommand(command: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("mpv IPC connection is unavailable."));
    const requestId = this.requestId++;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(requestId, { reject, resolve }));
    socket.write(encodeCommand(command, requestId));
    return response;
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.process !== child) return;
    this.process = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    this.lifecycleState = "stopped";
    this.rejectPending(new Error("mpv process exited"));
    if (!this.disposed) this.emit({ expected: code === 0 || signal !== null, type: "exited" });
  }

  private rejectPending(cause: unknown): void {
    for (const resolver of this.pending.values()) resolver.reject(cause);
    this.pending.clear();
  }

  private emit(event: MpvClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function connectSocket(ipcPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(ipcPath, () => resolve(socket));
    socket.once("error", (cause) => {
      socket.destroy();
      reject(cause);
    });
  });
}
