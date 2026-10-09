import { createCollection, type Collection } from "@tanstack/db";
import { Effect, Exit, Schema, Scope } from "effect";
import { expect } from "vitest";

import { createMirrorClient, mirrorCollectionOptions, type MirrorClient, type MirrorClientOptions, type MirrorCollectionUtils } from "../client/index.js";
import { memoryTable } from "../memory/index.js";
import type { MirrorRow } from "../protocol.js";
import { MemoryMirror, type MemoryMirrorOptions, type MemoryMirrorService } from "../server/memory/index.js";
import { createMemoryTransport, type MemoryConnection, type MemoryTransportOptions } from "../testing/index.js";
import { eventually, rowsOf, sortRows, stripVirtual } from "./harness.js";

/** Nested values and a transformation, so the tests see rows cross in their encoded form. */
export const Player = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.Union([Schema.TaggedStruct("Idle", {}), Schema.TaggedStruct("Playing", { track: Schema.String, positionSeconds: Schema.Finite })]),
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  joined: Schema.NullOr(Schema.DateFromMillis),
  tags: Schema.Array(Schema.String),
});
export type Player = typeof Player.Type;
export const players = memoryTable("players", Player, { primaryKey: "id" });

export const Counter = Schema.Struct({ id: Schema.Finite, count: Schema.Finite });
export type Counter = typeof Counter.Type;
export const counters = memoryTable("counters", Counter, { primaryKey: "id" });

export const player = (id: string, overrides: Partial<Player> = {}): Player => ({ id, name: `Player ${id}`, status: { _tag: "Idle" }, volume: 50, joined: null, tags: [], ...overrides });

export type MemoryHarnessOptions = {
  readonly latency?: MemoryTransportOptions["latency"];
  readonly server?: Partial<MemoryMirrorOptions>;
};

export type MemoryClient = {
  readonly connection: MemoryConnection;
  readonly client: MirrorClient;
  readonly players: Collection<Player, string, MirrorCollectionUtils>;
  readonly counters: Collection<Counter, number, MirrorCollectionUtils>;
};

export async function createMemoryHarness(options: MemoryHarnessOptions = {}) {
  const transport = createMemoryTransport({ latency: options.latency });
  const serverOptions: MemoryMirrorOptions = { tables: [players, counters], ...options.server };

  let serverScope: Scope.Closeable | null = null;
  let server!: MemoryMirrorService;

  /** Starts a fresh server, as a restarted process would: its data starts empty. */
  const startServer = async () => {
    if (serverScope) await Effect.runPromise(Scope.close(serverScope, Exit.void));
    const scope = await Effect.runPromise(Scope.make());
    serverScope = scope;
    server = await Effect.runPromise(
      Effect.gen(function* () {
        const next = yield* MemoryMirror.make(serverOptions);
        yield* next.serve(transport.server);
        return next;
      }).pipe(Scope.provide(scope)),
    );
    return server;
  };
  await startServer();

  const clients: Array<MemoryClient> = [];
  const connect = (clientOptions: Partial<Omit<MirrorClientOptions, "transport">> & { latency?: MemoryTransportOptions["latency"]; readOnly?: boolean } = {}): MemoryClient => {
    const { latency, readOnly, ...rest } = clientOptions;
    const connection = transport.connect({ latency });
    const client = createMirrorClient({ transport: connection, ...rest });
    const connected: MemoryClient = {
      connection,
      client,
      players: createCollection(mirrorCollectionOptions({ client, table: players, readOnly })),
      counters: createCollection(mirrorCollectionOptions({ client, table: counters, readOnly })),
    };
    clients.push(connected);
    return connected;
  };

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  /** The server's rows, in the same order as `rowsOf`. */
  const serverRows = async (table: "players" | "counters"): Promise<Array<MirrorRow>> =>
    sortRows((table === "players" ? await run(server.rows(players)) : await run(server.rows(counters))).map(stripVirtual));

  const dispose = async () => {
    for (const { client, players: playerCollection, counters: counterCollection, connection } of clients) {
      await Promise.all([playerCollection.cleanup(), counterCollection.cleanup()]);
      client.dispose();
      connection.close();
    }
    if (serverScope) await run(Scope.close(serverScope, Exit.void));
  };

  return {
    transport,
    get server() {
      return server;
    },
    startServer,
    connect,
    run,
    serverRows,
    dispose,
  };
}

export type MemoryHarness = Awaited<ReturnType<typeof createMemoryHarness>>;

/** Waits until both collections of `connected` equal the server's tables. */
export async function expectMemoryInSync(harness: MemoryHarness, connected: MemoryClient, timeoutMs?: number): Promise<void> {
  await eventually(async () => {
    expect(rowsOf(connected.players)).toEqual(await harness.serverRows("players"));
    expect(rowsOf(connected.counters)).toEqual(await harness.serverRows("counters"));
  }, timeoutMs);
}
