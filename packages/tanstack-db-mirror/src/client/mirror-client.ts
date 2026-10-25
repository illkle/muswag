import {
  MIRROR_PROTOCOL_VERSION,
  type MirrorChange,
  type MirrorChangeBatch,
  type MirrorClientTransport,
  type MirrorPosition,
  type MirrorRequestPayloads,
  type MirrorRequestType,
  type MirrorResults,
} from "../protocol.js";

/** An error raised by the server while handling a request. */
export class MirrorRemoteError extends Error {
  override readonly name = "MirrorRemoteError";
  constructor(
    readonly remoteName: string,
    message: string,
  ) {
    super(`${remoteName}: ${message}`);
  }
}

export class MirrorTimeoutError extends Error {
  override readonly name = "MirrorTimeoutError";
}

export class MirrorClientDisposedError extends Error {
  override readonly name = "MirrorClientDisposedError";
  constructor() {
    super("Mirror client was disposed");
  }
}

export type MirrorClientEvent = { readonly type: "batch"; readonly batch: MirrorChangeBatch } | { readonly type: "reset" };

export interface MirrorClientOptions {
  readonly transport: MirrorClientTransport;
  /** Defaults to 60 seconds. Snapshots of large tables go through the same request path. */
  readonly requestTimeoutMs?: number | undefined;
  /** How long `awaitPosition` waits for a position to sync when it is not given a timeout. Defaults to 30 seconds. */
  readonly positionTimeoutMs?: number | undefined;
  /**
   * How often a connected client asks the server how far its stream has got, to recover a lost batch
   * that no later batch revealed, or a restart it missed. Defaults to 5 seconds; `0` turns it off.
   */
  readonly heartbeatMs?: number | undefined;
}

const STALE_HELLO_ATTEMPTS = 20;
const STALE_HELLO_RETRY_MS = 10;
const CATCH_UP_DELAY_MS = 250;

/**
 * Owns one connection to a mirror server: tracks the contiguous position in its change stream,
 * recovers from gaps, and fans batches out to mirror collections.
 */
export class MirrorClient {
  readonly requestTimeoutMs: number;
  readonly positionTimeoutMs: number;

  private readonly transport: MirrorClientTransport;
  private readonly listeners = new Set<(event: MirrorClientEvent) => void>();
  private readonly unsubscribeTransport: () => void;

  /** Epoch of the server the stream is connected to. */
  private connectedEpoch: number | null = null;
  /** Highest epoch seen in any message. A lower one comes from a server that has been replaced. */
  private latestEpoch = 0;
  /** Every change up to and including `cursor` has been delivered to listeners. */
  private cursor: number | null = null;
  private pending: Array<MirrorChangeBatch> = [];
  private pulling = false;
  private connecting: Promise<void> | null = null;
  private verifying: Promise<void> | null = null;
  /** Bumped on every reset so in-flight work from before it is discarded. */
  private generation = 0;
  private disposed = false;
  private readonly heartbeat: ReturnType<typeof setInterval> | null;

  constructor(options: MirrorClientOptions) {
    this.transport = options.transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.positionTimeoutMs = options.positionTimeoutMs ?? 30_000;
    this.unsubscribeTransport = this.transport.subscribe((batch) => {
      if (this.disposed) return;
      this.pending.push(batch);
      this.drain();
    });
    const heartbeatMs = options.heartbeatMs ?? 5_000;
    this.heartbeat = heartbeatMs > 0 ? setInterval(() => this.checkPosition(), heartbeatMs) : null;
  }

  /** Epoch of the connected server, or `null` while (re)connecting. */
  get epoch(): number | null {
    return this.connectedEpoch;
  }

  /** Last stream position delivered to collections, or `null` while (re)connecting. */
  get position(): MirrorPosition | null {
    return this.connectedEpoch === null || this.cursor === null ? null : { epoch: this.connectedEpoch, seq: this.cursor };
  }

  async request<T extends MirrorRequestType>(type: T, payload: MirrorRequestPayloads[T]): Promise<MirrorResults[T]> {
    if (this.disposed) throw new MirrorClientDisposedError();
    const request = { v: MIRROR_PROTOCOL_VERSION, type, ...payload } as Parameters<MirrorClientTransport["request"]>[0];
    const response = await withTimeout(this.transport.request(request), this.requestTimeoutMs, `Mirror request "${type}" timed out after ${this.requestTimeoutMs}ms`);
    if (!response.ok) throw new MirrorRemoteError(response.error.name, response.error.message);
    return response.result as MirrorResults[T];
  }

  /** Resolves once the stream is established. Collections must subscribe before calling this. */
  ensureConnected(): Promise<void> {
    if (this.disposed) return Promise.reject(new MirrorClientDisposedError());
    if (this.cursor !== null) return Promise.resolve();
    this.connecting ??= this.connect();
    return this.connecting;
  }

  /**
   * @internal Reports an epoch seen in a response. A newer one than the connected server's means
   * the server restarted, so the stream reconnects and collections reload.
   */
  observeEpoch(epoch: number): void {
    if (epoch > this.latestEpoch) this.latestEpoch = epoch;
    if (this.connectedEpoch !== null && epoch > this.connectedEpoch) this.reset();
  }

  subscribe(listener: (event: MirrorClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Calls `listener` with the changes of each batch that touches one of `tables`, and with `null` when
   * the stream starts over, after which any of their rows may have changed.
   */
  onTableChange(tables: ReadonlyArray<string>, listener: (changes: ReadonlyArray<MirrorChange> | null) => void): () => void {
    const names = new Set(tables);
    return this.subscribe((event) => {
      if (event.type === "reset") return listener(null);
      const changes = event.batch.changes.filter((change) => names.has(change.table));
      if (changes.length > 0) listener(changes);
    });
  }

  /** Drops the stream position; collections reload from fresh snapshots. */
  reset(): void {
    if (this.disposed) return;
    this.generation++;
    this.connectedEpoch = null;
    this.cursor = null;
    this.pending = [];
    this.pulling = false;
    this.connecting = null;
    this.emit({ type: "reset" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribeTransport();
    this.listeners.clear();
    this.pending = [];
  }

  /**
   * Asks the server for its epoch and reconnects if it is not the one the stream is on. Concurrent
   * calls share one request.
   */
  private verifyEpoch(): Promise<void> {
    if (this.verifying) return this.verifying;
    const generation = this.generation;
    this.verifying = this.request("hello", {})
      .then(
        (hello) => {
          if (generation === this.generation && this.connectedEpoch !== null && hello.epoch !== this.connectedEpoch) this.reset();
        },
        () => undefined,
      )
      .finally(() => {
        this.verifying = null;
      });
    return this.verifying;
  }

  /**
   * @internal Called with a position the server has already broadcast past. If the stream has not
   * caught up shortly after, the batch was lost and nothing later revealed the gap, so pull it.
   */
  expect(position: MirrorPosition): void {
    const generation = this.generation;
    setTimeout(() => {
      if (generation !== this.generation || this.disposed || this.pulling) return;
      if (this.connectedEpoch !== position.epoch || this.cursor === null || this.cursor >= position.seq) return;
      this.pull(this.cursor);
    }, CATCH_UP_DELAY_MS);
  }

  /** Compares the stream with the server's position: pulls what it is missing, or reconnects to a different server. */
  private checkPosition(): void {
    const generation = this.generation;
    const epoch = this.connectedEpoch;
    if (this.disposed || epoch === null || this.cursor === null || this.pulling) return;
    this.request("hello", {}).then(
      (hello) => {
        if (generation !== this.generation || this.disposed) return;
        // A newer epoch reconnects; a lower one may be a replaced server answering late, so ask again.
        if (hello.epoch > epoch) return this.observeEpoch(hello.epoch);
        if (hello.epoch < epoch) return void this.verifyEpoch();
        // The batch up to `hello.seq` may still be on its way; `expect` pulls only if it does not arrive.
        if (this.cursor !== null && hello.seq > this.cursor) this.expect({ epoch, seq: hello.seq });
      },
      // An unreachable server is retried on the next beat.
      () => undefined,
    );
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    try {
      for (let attempt = 1; ; attempt++) {
        const hello = await this.request("hello", {});
        if (generation !== this.generation) return this.ensureConnected();
        // A lower epoch is normally a replaced server answering late, so ask again. If it keeps
        // answering it is the live one (e.g. the clock moved back); accept it.
        if (hello.epoch >= this.latestEpoch || attempt >= STALE_HELLO_ATTEMPTS) {
          this.latestEpoch = hello.epoch;
          this.connectedEpoch = hello.epoch;
          this.cursor = hello.seq;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, STALE_HELLO_RETRY_MS));
        if (generation !== this.generation) return this.ensureConnected();
      }
    } finally {
      if (generation === this.generation) this.connecting = null;
    }
    this.drain();
  }

  private drain(): void {
    while (!this.pulling && this.cursor !== null && !this.disposed) {
      const batch = this.pending.shift();
      if (!batch) return;
      this.process(batch);
    }
  }

  private process(batch: MirrorChangeBatch): void {
    const cursor = this.cursor;
    const epoch = this.connectedEpoch;
    if (cursor === null || epoch === null) return;
    if (batch.epoch < epoch) {
      void this.verifyEpoch();
      return;
    }
    if (batch.epoch > epoch) {
      this.observeEpoch(batch.epoch);
      return;
    }
    if (batch.toSeq <= cursor) return;
    if (batch.fromSeq > cursor) {
      this.pending.unshift(batch);
      this.pull(cursor);
      return;
    }

    const changes = batch.fromSeq === cursor ? batch.changes : batch.changes.filter((change) => change.seq > cursor);
    this.cursor = batch.toSeq;
    this.emit({ type: "batch", batch: { ...batch, fromSeq: cursor, changes } });
  }

  private pull(fromSeq: number): void {
    const generation = this.generation;
    this.pulling = true;
    this.request("pull", { fromSeq }).then(
      (result) => {
        if (generation !== this.generation) return;
        this.pulling = false;
        if (result.epoch !== this.connectedEpoch || result.kind === "reset") {
          this.observeEpoch(result.epoch);
          if (generation === this.generation) this.reset();
          return;
        }
        this.process(result.batch);
        // Every buffered batch was committed before the pull ran, so a remaining gap means the
        // server lost changes; start over rather than pull in a loop.
        const next = this.pending[0];
        if (next && this.cursor !== null && next.epoch === this.connectedEpoch && next.fromSeq > this.cursor) {
          this.reset();
          return;
        }
        this.drain();
      },
      () => {
        if (generation !== this.generation) return;
        this.reset();
      },
    );
  }

  private emit(event: MirrorClientEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (cause) {
        console.error("[tanstack-db-mirror] collection failed to apply a change", cause);
      }
    }
  }
}

export function createMirrorClient(options: MirrorClientOptions): MirrorClient {
  return new MirrorClient(options);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new MirrorTimeoutError(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
