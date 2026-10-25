import type { MirrorChangeBatch, MirrorClientTransport, MirrorRequest, MirrorResponse, MirrorServerTransport } from "../protocol.js";

export type Latency = number | (() => number);

export interface MemoryTransportOptions {
  /** Delay applied to every request, response and batch delivery, in milliseconds. Defaults to 0. */
  readonly latency?: Latency | undefined;
}

export interface MemoryConnection extends MirrorClientTransport {
  /** Requests sent through this connection, for assertions. */
  readonly requests: ReadonlyArray<MirrorRequest>;
  /** Holds batch deliveries until `resume` is called. */
  pause(): void;
  resume(): void;
  /** Silently drops the next `count` batches, to simulate lost messages. */
  dropNextBatches(count: number): void;
  /** Resolves once every queued batch has been delivered or dropped. */
  flushed(): Promise<void>;
  close(): void;
}

export interface MemoryTransport {
  readonly server: MirrorServerTransport;
  connect(options?: MemoryTransportOptions): MemoryConnection;
}

/**
 * In-process transport that behaves like Electron IPC: payloads are structured-cloned, delivery is
 * asynchronous, requests and batches each stay in order per connection, and a connection only
 * receives batches after its first request reached the server. Responses are not ordered relative
 * to each other or to batches.
 */
export function createMemoryTransport(options: MemoryTransportOptions = {}): MemoryTransport {
  let handler: ((request: unknown) => Promise<MirrorResponse>) | null = null;
  const connections = new Set<ConnectionState>();

  const server: MirrorServerTransport = {
    listen: (next) => {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
    broadcast: (batch) => {
      for (const connection of connections) {
        if (connection.registered) connection.enqueue(structuredClone(batch));
      }
    },
  };

  return {
    server,
    connect: (connectionOptions = {}) => {
      const latency = connectionOptions.latency ?? options.latency ?? 0;
      const state = new ConnectionState(latency);
      connections.add(state);

      const connection: MemoryConnection = {
        requests: state.requests,
        request: async <T extends MirrorRequest["type"]>(request: MirrorRequest<T>) => {
          if (state.closed) throw new Error("Memory connection is closed");
          state.requests.push(request as MirrorRequest);
          // Requests reach the server in send order, like Electron IPC messages from one renderer.
          const delivered = state.requestChain.then(() => sleep(resolveLatency(latency)));
          state.requestChain = delivered;
          await delivered;
          const current = handler;
          if (!current) throw new Error("No mirror server is listening");
          state.registered = true;
          const response = await current(structuredClone(request));
          await sleep(resolveLatency(latency));
          return structuredClone(response) as MirrorResponse<T>;
        },
        subscribe: (listener) => {
          state.listeners.add(listener);
          return () => {
            state.listeners.delete(listener);
          };
        },
        pause: () => {
          state.paused = true;
        },
        resume: () => {
          state.paused = false;
          state.pump();
        },
        dropNextBatches: (count) => {
          state.dropCount += count;
        },
        flushed: () => state.flushed(),
        close: () => {
          state.closed = true;
          state.queue.length = 0;
          state.listeners.clear();
          connections.delete(state);
        },
      };
      return connection;
    },
  };
}

class ConnectionState {
  readonly requests: Array<MirrorRequest> = [];
  readonly listeners = new Set<(batch: MirrorChangeBatch) => void>();
  readonly queue: Array<MirrorChangeBatch> = [];
  requestChain: Promise<void> = Promise.resolve();
  registered = false;
  paused = false;
  closed = false;
  dropCount = 0;
  private pumping = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly latency: Latency) {}

  enqueue(batch: MirrorChangeBatch) {
    if (this.closed) return;
    this.queue.push(batch);
    this.pump();
  }

  pump() {
    if (this.pumping || this.paused || this.closed) return;
    const next = this.queue.shift();
    if (!next) {
      this.notifyIdle();
      return;
    }
    this.pumping = true;
    setTimeout(() => {
      this.pumping = false;
      if (this.closed) return;
      if (this.dropCount > 0) this.dropCount--;
      else for (const listener of this.listeners) listener(next);
      this.pump();
    }, resolveLatency(this.latency));
  }

  flushed(): Promise<void> {
    if (this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

const resolveLatency = (latency: Latency) => (typeof latency === "function" ? latency() : latency);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
