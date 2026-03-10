import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { createConnection } from "node:net";

import { eq } from "drizzle-orm";
import type { BetterSqliteDrizzleDb } from "@muswag/db";
import { userCredentialsTable } from "@muswag/db";

import type { PlayQueueInput, PlayerEvent, PlayerQueueItem, PlayerState } from "../shared/player";
import { createDefaultPlayerState } from "../shared/player";

const USER_CREDENTIALS_ROW_ID = 1;
const SUBSONIC_API_VERSION = "1.16.1";
const SOCKET_CONNECT_ATTEMPTS = 50;
const SOCKET_CONNECT_DELAY_MS = 100;
const POSITION_BROADCAST_INTERVAL_MS = 250;

type CommandResponse = {
  data?: unknown;
  error?: string;
};

type CommandResolver = {
  resolve: (value: CommandResponse) => void;
  reject: (reason?: unknown) => void;
};

type MpvControllerOptions = {
  getDb: () => BetterSqliteDrizzleDb;
  ipcPath: string;
  mpvBinaryPath: string;
  onEvent: (event: PlayerEvent) => void;
};

export class MpvController {
  private readonly getDb: MpvControllerOptions["getDb"];
  private readonly ipcPath: string;
  private readonly mpvBinaryPath: string;
  private readonly onEvent: MpvControllerOptions["onEvent"];
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly pendingCommands = new Map<number, CommandResolver>();

  private operationChain: Promise<void> = Promise.resolve();
  private state = createDefaultPlayerState();
  private mpvProcess: ChildProcess | undefined;
  private socket: Socket | undefined;
  private connectPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private incomingBuffer = "";
  private lastKnownPause = false;
  private isDisposing = false;
  private lastBroadcastAt = 0;
  private scheduledProgressBroadcast: NodeJS.Timeout | undefined;

  constructor(options: MpvControllerOptions) {
    this.getDb = options.getDb;
    this.ipcPath = options.ipcPath;
    this.mpvBinaryPath = options.mpvBinaryPath;
    this.onEvent = options.onEvent;
    logMpvDebug("controller:init", {
      ipcPath: this.ipcPath,
      mpvBinaryPath: this.mpvBinaryPath,
    });
  }

  getState(): PlayerState {
    return clonePlayerState(this.state);
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  async playQueue(input: PlayQueueInput): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:playQueue", {
        queueLength: input.queue.length,
        startIndex: input.startIndex,
        startTrackId: input.queue[input.startIndex]?.id ?? null,
      });
      if (input.queue.length === 0) {
        await this.stopPlayback();
        this.state.queue = [];
        this.state.currentIndex = -1;
        this.syncCurrentTrack();
        this.state.status = "idle";
        this.state.error = null;
        this.state.positionSeconds = 0;
        this.state.durationSeconds = null;
        this.broadcast();
        return this.getState();
      }

      const startIndex = clampIndex(input.startIndex, input.queue.length);
      this.state.queue = input.queue.map(cloneQueueItem);
      this.state.currentIndex = startIndex;
      this.syncCurrentTrack();
      this.state.positionSeconds = 0;
      this.state.durationSeconds = this.state.currentTrack?.duration ?? null;
      this.state.error = null;
      this.state.status = "loading";
      this.broadcast();

      await this.playCurrentTrack();
      return this.getState();
    });
  }

  async play(): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:play", summarizeState(this.state));
      if (!this.state.currentTrack) {
        return this.getState();
      }

      if (this.state.status === "ended") {
        await this.playCurrentTrack();
        return this.getState();
      }

      await this.setPause(false);
      return this.getState();
    });
  }

  async pause(): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:pause", summarizeState(this.state));
      if (!this.state.currentTrack) {
        return this.getState();
      }

      await this.setPause(true);
      return this.getState();
    });
  }

  async toggle(): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:toggle", summarizeState(this.state));
      if (!this.state.currentTrack) {
        return this.getState();
      }

      if (this.state.status === "ended") {
        await this.playCurrentTrack();
        return this.getState();
      }

      await this.setPause(!(this.state.status === "paused"));
      return this.getState();
    });
  }

  async seek(positionSeconds: number): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:seek", { positionSeconds });
      if (!this.state.currentTrack) {
        return this.getState();
      }

      await this.performSeek(positionSeconds);
      return this.getState();
    });
  }

  async next(): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:next", summarizeState(this.state));
      if (!this.state.currentTrack) {
        return this.getState();
      }

      if (this.state.currentIndex >= this.state.queue.length - 1) {
        return this.getState();
      }

      this.state.currentIndex += 1;
      this.syncCurrentTrack();
      this.state.positionSeconds = 0;
      this.state.durationSeconds = this.state.currentTrack?.duration ?? null;
      this.state.status = "loading";
      this.state.error = null;
      this.broadcast();

      await this.playCurrentTrack();
      return this.getState();
    });
  }

  async previous(): Promise<PlayerState> {
    return this.enqueue(async () => {
      logMpvDebug("action:previous", summarizeState(this.state));
      if (!this.state.currentTrack) {
        return this.getState();
      }

      if (this.state.positionSeconds > 5) {
        await this.performSeek(0);
        return this.getState();
      }

      if (this.state.currentIndex <= 0) {
        await this.performSeek(0);
        return this.getState();
      }

      this.state.currentIndex -= 1;
      this.syncCurrentTrack();
      this.state.positionSeconds = 0;
      this.state.durationSeconds = this.state.currentTrack?.duration ?? null;
      this.state.status = "loading";
      this.state.error = null;
      this.broadcast();

      await this.playCurrentTrack();
      return this.getState();
    });
  }

  dispose(): void {
    logMpvDebug("controller:dispose");
    this.isDisposing = true;

    for (const pending of this.pendingCommands.values()) {
      pending.reject(new Error("mpv controller disposed"));
    }
    this.pendingCommands.clear();

    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify({ command: ["quit"] })}\n`);
      this.socket.end();
      this.socket.destroy();
    }
    this.socket = undefined;

    if (this.mpvProcess && !this.mpvProcess.killed) {
      this.mpvProcess.kill();
    }
    this.mpvProcess = undefined;
    if (this.scheduledProgressBroadcast) {
      clearTimeout(this.scheduledProgressBroadcast);
      this.scheduledProgressBroadcast = undefined;
    }

    if (process.platform !== "win32") {
      rmSync(this.ipcPath, { force: true });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private broadcast(): void {
    this.lastBroadcastAt = Date.now();
    logMpvDebug("broadcast:state", summarizeState(this.state));
    const event: PlayerEvent = {
      type: "state",
      state: this.getState(),
    };

    this.onEvent(event);

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private syncCurrentTrack(): void {
    this.state.currentTrack = this.state.queue[this.state.currentIndex] ?? null;
  }

  private applyError(cause: unknown): void {
    const message = cause instanceof Error ? cause.message : "Playback failed";
    logMpvError("state:error", cause);
    this.state.error = message;
    this.state.status = "error";
    this.state.mpvAvailable = !message.includes("mpv binary was not found");
    this.broadcast();
  }

  private async playCurrentTrack(): Promise<void> {
    const currentTrack = this.state.currentTrack;
    if (!currentTrack) {
      return;
    }

    try {
      const credentials = await this.loadCredentials();
      const streamUrl = buildStreamUrl(credentials.url, credentials.username, credentials.password, currentTrack.id);
      logMpvDebug("track:load", {
        trackId: currentTrack.id,
        title: currentTrack.title,
        streamUrl: sanitizeStreamUrl(streamUrl),
      });

      await this.ensureReady();
      await this.command(["loadfile", streamUrl, "replace"]);

      this.state.positionSeconds = 0;
      this.state.durationSeconds = currentTrack.duration ?? null;
      this.state.status = "loading";
      this.state.error = null;
      this.broadcast();
    } catch (cause) {
      this.applyError(cause);
    }
  }

  private async setPause(paused: boolean): Promise<void> {
    try {
      logMpvDebug("track:setPause", { paused });
      await this.ensureReady();
      await this.command(["set_property", "pause", paused]);
      this.lastKnownPause = paused;
      this.state.status = paused ? "paused" : "playing";
      this.state.error = null;
      this.broadcast();
    } catch (cause) {
      this.applyError(cause);
    }
  }

  private async performSeek(positionSeconds: number): Promise<void> {
    const boundedPosition = Math.max(
      0,
      Math.min(positionSeconds, this.state.durationSeconds ?? positionSeconds),
    );

    try {
      logMpvDebug("track:seek", { boundedPosition });
      await this.command(["seek", boundedPosition, "absolute+exact"]);
      this.state.positionSeconds = boundedPosition;
      if (this.state.status === "ended") {
        this.state.status = this.lastKnownPause ? "paused" : "playing";
      }
      this.broadcast();
    } catch (cause) {
      this.applyError(cause);
    }
  }

  private async stopPlayback(): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      return;
    }

    try {
      logMpvDebug("track:stop");
      await this.command(["stop"]);
    } catch {
      return;
    }
  }

  private async loadCredentials(): Promise<{ url: string; username: string; password: string }> {
    const rows = await this.getDb()
      .select()
      .from(userCredentialsTable)
      .where(eq(userCredentialsTable.id, USER_CREDENTIALS_ROW_ID))
      .limit(1);

    const credentials = rows[0];
    if (!credentials) {
      throw new Error("You need to log in before playback can start.");
    }

    logMpvDebug("credentials:loaded", {
      url: credentials.url,
      username: credentials.username,
    });

    return credentials;
  }

  private async ensureReady(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.mpvProcess && !this.mpvProcess.killed) {
      logMpvDebug("mpv:ensureReady:reuse");
      return;
    }

    if (!this.connectPromise) {
      logMpvDebug("mpv:ensureReady:start");
      this.connectPromise = this.startMpv().finally(() => {
        logMpvDebug("mpv:ensureReady:complete");
        this.connectPromise = undefined;
      });
    }

    await this.connectPromise;
  }

  private async startMpv(): Promise<void> {
    if (process.platform !== "win32") {
      rmSync(this.ipcPath, { force: true });
    }

    const args = [
      "--idle=yes",
      "--no-video",
      "--audio-display=no",
      "--force-window=no",
      "--terminal=no",
      `--input-ipc-server=${this.ipcPath}`,
    ];

    const child = spawn(this.mpvBinaryPath, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    logMpvDebug("mpv:spawn", {
      binary: this.mpvBinaryPath,
      args,
    });

    this.mpvProcess = child;

    child.on("exit", (code, signal) => {
      if (this.mpvProcess !== child) {
        return;
      }

      this.mpvProcess = undefined;
      this.socket = undefined;

      for (const pending of this.pendingCommands.values()) {
        pending.reject(new Error("mpv process exited"));
      }
      this.pendingCommands.clear();
      logMpvDebug("mpv:exit", { code, signal });

      if (!this.isDisposing && code !== 0 && signal === null) {
        this.state.error = "mpv exited unexpectedly.";
        this.state.status = "error";
        this.broadcast();
      }
    });

    try {
      const socket = await Promise.race([
        this.connectSocket(),
        new Promise<never>((_, reject) => {
          child.once("error", reject);
        }),
      ]);
      logMpvDebug("mpv:socket:connected");
      this.attachSocket(socket);
      this.state.mpvAvailable = true;
      this.state.error = null;

      await Promise.all([
        this.rawCommand(["observe_property", 1, "pause"]),
        this.rawCommand(["observe_property", 2, "time-pos"]),
        this.rawCommand(["observe_property", 3, "duration"]),
      ]);
    } catch (cause) {
      logMpvError("mpv:start:error", cause);
      child.kill();

      if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        throw new Error("The mpv binary was not found on PATH.");
      }

      throw cause;
    }
  }

  private async connectSocket(): Promise<Socket> {
    for (let attempt = 0; attempt < SOCKET_CONNECT_ATTEMPTS; attempt += 1) {
      try {
        logMpvDebug("mpv:socket:connectAttempt", { attempt: attempt + 1 });
        const socket = await new Promise<Socket>((resolve, reject) => {
          const connection = createConnection(this.ipcPath, () => {
            resolve(connection);
          });

          connection.once("error", (cause) => {
            connection.destroy();
            reject(cause);
          });
        });

        return socket;
      } catch (cause) {
        logMpvDebug("mpv:socket:connectRetry", {
          attempt: attempt + 1,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        if (attempt === SOCKET_CONNECT_ATTEMPTS - 1) {
          throw cause;
        }

        await delay(SOCKET_CONNECT_DELAY_MS);
      }
    }

    throw new Error("Timed out connecting to the mpv IPC server.");
  }

  private attachSocket(socket: Socket): void {
    this.socket = socket;
    this.incomingBuffer = "";
    logMpvDebug("mpv:socket:attach");

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.incomingBuffer += chunk;
      this.flushIncomingMessages();
    });

    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      logMpvDebug("mpv:socket:close");
    });

    socket.on("error", (cause) => {
      logMpvError("mpv:socket:error", cause);
      if (!this.isDisposing) {
        this.applyError(cause);
      }
    });
  }

  private flushIncomingMessages(): void {
    let newlineIndex = this.incomingBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawMessage = this.incomingBuffer.slice(0, newlineIndex).trim();
      this.incomingBuffer = this.incomingBuffer.slice(newlineIndex + 1);

      if (rawMessage.length > 0) {
        this.handleIncomingMessage(rawMessage);
      }

      newlineIndex = this.incomingBuffer.indexOf("\n");
    }
  }

  private handleIncomingMessage(rawMessage: string): void {
    logMpvDebug("mpv:incoming:raw", { rawMessage });
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(rawMessage) as Record<string, unknown>;
    } catch {
      return;
    }

    const requestId = typeof payload.request_id === "number" ? payload.request_id : null;
    if (requestId !== null) {
      logMpvDebug("mpv:incoming:response", {
        requestId,
        error: payload.error,
        hasData: "data" in payload,
      });
      const pending = this.pendingCommands.get(requestId);
      if (pending) {
        this.pendingCommands.delete(requestId);
        if (payload.error && payload.error !== "success") {
          pending.reject(new Error(String(payload.error)));
        } else {
          pending.resolve({
            data: payload.data,
            error: typeof payload.error === "string" ? payload.error : undefined,
          });
        }
      }
      return;
    }

    if (payload.event === "property-change") {
      logMpvDebug("mpv:incoming:event", {
        event: payload.event,
        name: payload.name,
        data: payload.data,
      });
      this.handlePropertyChange(payload.name, payload.data);
      return;
    }

    if (payload.event === "file-loaded") {
      logMpvDebug("mpv:incoming:event", { event: payload.event });
      this.state.status = this.lastKnownPause ? "paused" : "playing";
      this.state.error = null;
      this.broadcast();
      return;
    }

    if (payload.event === "end-file") {
      logMpvDebug("mpv:incoming:event", { event: payload.event, reason: payload.reason });
      const reason = payload.reason;
      if (reason === "eof") {
        void this.enqueue(async () => {
          if (this.state.currentIndex < this.state.queue.length - 1) {
            this.state.currentIndex += 1;
            this.syncCurrentTrack();
            this.state.positionSeconds = 0;
            this.state.durationSeconds = this.state.currentTrack?.duration ?? null;
            this.state.status = "loading";
            this.broadcast();
            await this.playCurrentTrack();
            return;
          }

          this.state.positionSeconds = this.state.durationSeconds ?? this.state.positionSeconds;
          this.state.status = "ended";
          this.broadcast();
        });
      }
    }
  }

  private handlePropertyChange(name: unknown, value: unknown): void {
    logMpvDebug("mpv:property-change", { name, value });
    if (name === "pause") {
      this.lastKnownPause = value === true;

      if (this.state.status !== "loading" && this.state.status !== "ended") {
        this.state.status = this.lastKnownPause ? "paused" : "playing";
      }

      this.broadcast();
      return;
    }

    if (name === "time-pos") {
      this.state.positionSeconds = typeof value === "number" ? value : 0;
      this.broadcastPositionUpdate();
      return;
    }

    if (name === "duration") {
      this.state.durationSeconds = typeof value === "number" ? value : this.state.currentTrack?.duration ?? null;
      this.broadcast();
    }
  }

  private async command(command: unknown[]): Promise<CommandResponse> {
    logMpvDebug("mpv:command:prepare", { command });
    await this.ensureReady();

    return this.rawCommand(command);
  }

  private broadcastPositionUpdate(): void {
    const now = Date.now();
    const elapsed = now - this.lastBroadcastAt;

    if (elapsed >= POSITION_BROADCAST_INTERVAL_MS) {
      this.broadcast();
      return;
    }

    if (this.scheduledProgressBroadcast) {
      return;
    }

    this.scheduledProgressBroadcast = setTimeout(() => {
      this.scheduledProgressBroadcast = undefined;
      this.broadcast();
    }, POSITION_BROADCAST_INTERVAL_MS - elapsed);
  }

  private async rawCommand(command: unknown[]): Promise<CommandResponse> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("mpv IPC connection is unavailable.");
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    logMpvDebug("mpv:command:send", { requestId, command });

    const response = new Promise<CommandResponse>((resolve, reject) => {
      this.pendingCommands.set(requestId, { resolve, reject });
    });

    socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
    return response;
  }
}

function clampIndex(value: number, queueLength: number): number {
  if (queueLength <= 0) {
    return -1;
  }

  return Math.max(0, Math.min(value, queueLength - 1));
}

function cloneQueueItem(item: PlayerQueueItem): PlayerQueueItem {
  return { ...item };
}

function clonePlayerState(state: PlayerState): PlayerState {
  return {
    ...state,
    queue: state.queue.map(cloneQueueItem),
    currentTrack: state.currentTrack ? cloneQueueItem(state.currentTrack) : null,
  };
}

function buildStreamUrl(baseUrl: string, username: string, password: string, songId: string): string {
  const salt = randomBytes(16).toString("hex");
  const token = createHash("md5")
    .update(`${password}${salt}`)
    .digest("hex");
  const url = new URL("stream.view", getRestBaseUrl(baseUrl));

  url.searchParams.set("id", songId);
  url.searchParams.set("u", username);
  url.searchParams.set("t", token);
  url.searchParams.set("s", salt);
  url.searchParams.set("v", SUBSONIC_API_VERSION);
  url.searchParams.set("c", "muswag");

  return url.toString();
}

function getRestBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const ensuredTrailingSlash = normalizedBaseUrl.endsWith("/") ? normalizedBaseUrl : `${normalizedBaseUrl}/`;

  if (ensuredTrailingSlash.endsWith("/rest/")) {
    return ensuredTrailingSlash;
  }

  return new URL("rest/", ensuredTrailingSlash).toString();
}

export function getDefaultMpvIpcPath(baseDirectory: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\muswag-mpv-${process.pid}`;
  }

  return join(baseDirectory, `muswag-mpv-${process.pid}.sock`);
}

function summarizeState(state: PlayerState): Record<string, unknown> {
  return {
    status: state.status,
    currentIndex: state.currentIndex,
    currentTrackId: state.currentTrack?.id ?? null,
    currentTrackTitle: state.currentTrack?.title ?? null,
    queueLength: state.queue.length,
    positionSeconds: roundSeconds(state.positionSeconds),
    durationSeconds: roundSeconds(state.durationSeconds),
    error: state.error,
    mpvAvailable: state.mpvAvailable,
  };
}

function roundSeconds(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  return Math.round(value * 100) / 100;
}

function sanitizeStreamUrl(streamUrl: string): string {
  const url = new URL(streamUrl);
  if (url.searchParams.has("t")) {
    url.searchParams.set("t", "<redacted>");
  }
  if (url.searchParams.has("s")) {
    url.searchParams.set("s", "<redacted>");
  }
  return url.toString();
}

function logMpvDebug(message: string, payload?: Record<string, unknown>): void {
  if (payload) {
    console.debug("[player][mpv][main]", message, payload);
    return;
  }

  console.debug("[player][mpv][main]", message);
}

function logMpvError(message: string, cause: unknown): void {
  console.error("[player][mpv][main]", message, cause);
}
