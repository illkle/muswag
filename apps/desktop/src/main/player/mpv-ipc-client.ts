import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SOCKET_CONNECT_ATTEMPTS = 50;
const SOCKET_CONNECT_DELAY_MS = 100;
const TIME_POS_LOG_INTERVAL_MS = 500;

type CommandResolver = {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
};

type MpvResponsePayload = {
  data?: unknown;
  error?: unknown;
  request_id?: unknown;
};

type MpvEventPayload = {
  data?: unknown;
  event?: unknown;
  name?: unknown;
  reason?: unknown;
};

export type MpvIpcClientOptions = {
  ipcPath: string;
  mpvBinaryPath: string;
};

export type MpvClientEvent =
  | { type: "duration-change"; durationSeconds: number | null }
  | { type: "end-file"; reason: string | null }
  | { type: "error"; cause: unknown }
  | { type: "file-loaded" }
  | { type: "pause-change"; paused: boolean }
  | { type: "time-pos-change"; positionSeconds: number }
  | { type: "unexpected-exit" };

const listeners = new Set<(event: MpvClientEvent) => void>();
const pendingCommands = new Map<number, CommandResolver>();

let clientOptions: MpvIpcClientOptions | undefined;
let mpvProcess: ChildProcess | undefined;
let socket: Socket | undefined;
let connectPromise: Promise<void> | undefined;
let nextRequestId = 1;
let incomingBuffer = "";
let isDisposing = false;
let lastTimePosLogAt = 0;

export function initializeMpvIpcClient(options: MpvIpcClientOptions): void {
  clientOptions = options;
  isDisposing = false;
}

export function subscribe(listener: (event: MpvClientEvent) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export async function loadFile(url: string): Promise<void> {
  await ensureReady();
  await sendCommand(["loadfile", url, "replace"]);
}

export async function setPause(paused: boolean): Promise<void> {
  await ensureReady();
  await sendCommand(["set_property", "pause", paused]);
}

export async function seekAbsolute(positionSeconds: number): Promise<void> {
  await ensureReady();
  await sendCommand(["seek", positionSeconds, "absolute+exact"]);
}

export async function stop(): Promise<void> {
  if (!socket || socket.destroyed) {
    return;
  }

  await sendCommand(["stop"]);
}

export function disposeMpvIpcClient(): void {
  console.debug("[player][mpv][main]", "mpv:client:dispose");
  isDisposing = true;

  for (const pending of pendingCommands.values()) {
    pending.reject(new Error("mpv controller disposed"));
  }
  pendingCommands.clear();

  if (socket && !socket.destroyed) {
    socket.write(`${JSON.stringify({ command: ["quit"] })}\n`);
    socket.end();
    socket.destroy();
  }
  socket = undefined;

  if (mpvProcess && !mpvProcess.killed) {
    mpvProcess.kill();
  }
  mpvProcess = undefined;

  if (clientOptions && process.platform !== "win32") {
    rmSync(clientOptions.ipcPath, { force: true });
  }

  clientOptions = undefined;
  connectPromise = undefined;
  incomingBuffer = "";
  nextRequestId = 1;
  lastTimePosLogAt = 0;
}

async function ensureReady(): Promise<void> {
  if (socket && !socket.destroyed && mpvProcess && !mpvProcess.killed) {
    console.debug("[player][mpv][main]", "mpv:ensureReady:reuse");
    return;
  }

  if (!connectPromise) {
    console.debug("[player][mpv][main]", "mpv:ensureReady:start");
    connectPromise = startMpv().finally(() => {
      console.debug("[player][mpv][main]", "mpv:ensureReady:complete");
      connectPromise = undefined;
    });
  }

  await connectPromise;
}

async function startMpv(): Promise<void> {
  const options = getClientOptions();

  if (process.platform !== "win32") {
    rmSync(options.ipcPath, { force: true });
  }

  const args = [
    "--idle=yes",
    "--no-video",
    "--audio-display=no",
    "--force-window=no",
    "--terminal=no",
    `--input-ipc-server=${options.ipcPath}`,
  ];
  const child = spawn(options.mpvBinaryPath, args, {
    stdio: ["ignore", "ignore", "ignore"],
  });

  console.debug("[player][mpv][main]", "mpv:spawn", {
    args,
    binary: options.mpvBinaryPath,
  });

  mpvProcess = child;
  child.on("exit", (code, signal) => {
    if (mpvProcess !== child) {
      return;
    }

    mpvProcess = undefined;
    socket = undefined;

    for (const pending of pendingCommands.values()) {
      pending.reject(new Error("mpv process exited"));
    }
    pendingCommands.clear();
    console.debug("[player][mpv][main]", "mpv:exit", { code, signal });

    if (!isDisposing && code !== 0 && signal === null) {
      emit({ type: "unexpected-exit" });
    }
  });

  try {
    const connectedSocket = await Promise.race([
      connectSocket(),
      new Promise<never>((_, reject) => {
        child.once("error", reject);
      }),
    ]);

    console.debug("[player][mpv][main]", "mpv:socket:connected");
    attachSocket(connectedSocket);

    await Promise.all([
      sendCommand(["observe_property", 1, "pause"]),
      sendCommand(["observe_property", 2, "time-pos"]),
      sendCommand(["observe_property", 3, "duration"]),
    ]);
  } catch (cause) {
    console.error("[player][mpv][main]", "mpv:start:error", cause);
    child.kill();

    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error("The mpv binary was not found on PATH.");
    }

    throw cause;
  }
}

async function connectSocket(): Promise<Socket> {
  const options = getClientOptions();

  for (let attempt = 0; attempt < SOCKET_CONNECT_ATTEMPTS; attempt += 1) {
    try {
      console.debug("[player][mpv][main]", "mpv:socket:connectAttempt", {
        attempt: attempt + 1,
      });
      const connectedSocket = await new Promise<Socket>((resolve, reject) => {
        const connection = createConnection(options.ipcPath, () => {
          resolve(connection);
        });

        connection.once("error", (cause) => {
          connection.destroy();
          reject(cause);
        });
      });

      return connectedSocket;
    } catch (cause) {
      console.debug("[player][mpv][main]", "mpv:socket:connectRetry", {
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

function attachSocket(nextSocket: Socket): void {
  socket = nextSocket;
  incomingBuffer = "";
  console.debug("[player][mpv][main]", "mpv:socket:attach");

  nextSocket.setEncoding("utf8");
  nextSocket.on("data", (chunk: string) => {
    incomingBuffer += chunk;
    flushIncomingMessages();
  });

  nextSocket.on("close", () => {
    if (socket === nextSocket) {
      socket = undefined;
    }
    console.debug("[player][mpv][main]", "mpv:socket:close");
  });

  nextSocket.on("error", (cause) => {
    console.error("[player][mpv][main]", "mpv:socket:error", cause);
    if (!isDisposing) {
      emit({ type: "error", cause });
    }
  });
}

function flushIncomingMessages(): void {
  let newlineIndex = incomingBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const rawMessage = incomingBuffer.slice(0, newlineIndex).trim();
    incomingBuffer = incomingBuffer.slice(newlineIndex + 1);

    if (rawMessage.length > 0) {
      handleIncomingMessage(rawMessage);
    }

    newlineIndex = incomingBuffer.indexOf("\n");
  }
}

function handleIncomingMessage(rawMessage: string): void {
  console.debug("[player][mpv][main]", "mpv:incoming:raw", { rawMessage });

  let payload: MpvResponsePayload & MpvEventPayload;
  try {
    payload = JSON.parse(rawMessage) as MpvResponsePayload & MpvEventPayload;
  } catch {
    return;
  }

  const requestId = typeof payload.request_id === "number" ? payload.request_id : null;
  if (requestId !== null) {
    console.debug("[player][mpv][main]", "mpv:incoming:response", {
      error: payload.error,
      hasData: "data" in payload,
      requestId,
    });

    const pending = pendingCommands.get(requestId);
    if (pending) {
      pendingCommands.delete(requestId);

      if (payload.error && payload.error !== "success") {
        pending.reject(new Error(String(payload.error)));
      } else {
        pending.resolve(payload.data);
      }
    }

    return;
  }

  if (payload.event === "property-change") {
    if (payload.name !== "time-pos" || shouldLogTimePosUpdate()) {
      console.debug("[player][mpv][main]", "mpv:incoming:event", {
        data: payload.data,
        event: payload.event,
        name: payload.name,
      });
    }

    handlePropertyChange(payload.name, payload.data);
    return;
  }

  if (payload.event === "file-loaded") {
    console.debug("[player][mpv][main]", "mpv:incoming:event", { event: payload.event });
    emit({ type: "file-loaded" });
    return;
  }

  if (payload.event === "end-file") {
    console.debug("[player][mpv][main]", "mpv:incoming:event", {
      event: payload.event,
      reason: payload.reason,
    });
    emit({
      reason: typeof payload.reason === "string" ? payload.reason : null,
      type: "end-file",
    });
  }
}

function handlePropertyChange(name: unknown, value: unknown): void {
  if (name !== "time-pos") {
    console.debug("[player][mpv][main]", "mpv:property-change", { name, value });
  }

  if (name === "pause") {
    emit({ paused: value === true, type: "pause-change" });
    return;
  }

  if (name === "time-pos") {
    emit({
      positionSeconds: typeof value === "number" ? value : 0,
      type: "time-pos-change",
    });
    return;
  }

  if (name === "duration") {
    emit({
      durationSeconds: typeof value === "number" ? value : null,
      type: "duration-change",
    });
  }
}

function shouldLogTimePosUpdate(): boolean {
  const now = Date.now();
  if (now - lastTimePosLogAt < TIME_POS_LOG_INTERVAL_MS) {
    return false;
  }

  lastTimePosLogAt = now;
  return true;
}

async function sendCommand(command: unknown[]): Promise<unknown> {
  if (!socket || socket.destroyed) {
    throw new Error("mpv IPC connection is unavailable.");
  }

  const requestId = nextRequestId;
  nextRequestId += 1;
  console.debug("[player][mpv][main]", "mpv:command:send", { command, requestId });

  const response = new Promise<unknown>((resolve, reject) => {
    pendingCommands.set(requestId, { reject, resolve });
  });

  socket.write(`${JSON.stringify({ command, request_id: requestId })}\n`);
  return response;
}

function emit(event: MpvClientEvent): void {
  for (const listener of listeners) {
    listener(event);
  }
}

function getClientOptions(): MpvIpcClientOptions {
  if (!clientOptions) {
    throw new Error("mpv IPC client has not been initialized.");
  }

  return clientOptions;
}

export function getDefaultMpvIpcPath(baseDirectory: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\muswag-mpv-${process.pid}`;
  }

  return join(baseDirectory, `muswag-mpv-${process.pid}.sock`);
}
