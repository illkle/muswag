import { createTransaction, type Transaction } from "@tanstack/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { mulberry32, sleep } from "../test/harness.js";
import { counters, createMemoryHarness, expectMemoryInSync, player, players, type MemoryClient, type MemoryHarness } from "../test/memory-harness.js";
import { MirrorClientDisposedError, MirrorRemoteError, MirrorTimeoutError } from "./index.js";

const EXPECTED_ERRORS = [MirrorRemoteError, MirrorTimeoutError, MirrorClientDisposedError];

let harness: MemoryHarness;

afterEach(async () => {
  await harness?.dispose();
});

async function runScenario(seed: number, steps: number) {
  const random = mulberry32(seed);
  const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  const playerIds = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const counterIds = Array.from({ length: 10 }, (_, i) => i);

  harness = await createMemoryHarness({ latency: () => random() * 4, server: { retainChanges: 15 } });
  const clients: Array<MemoryClient> = [0, 1, 2].map(() => harness.connect({ mutationTimeoutMs: 2_000, heartbeatMs: 100 }));

  const unexpected: Array<unknown> = [];
  const consoleErrors: Array<unknown> = [];
  const originalConsoleError = console.error;
  console.error = (...args: Array<unknown>) => consoleErrors.push(args);

  const pending: Array<Promise<unknown>> = [];
  const track = (tx: Transaction<any>) => {
    pending.push(
      tx.isPersisted.promise.catch((error: unknown) => {
        if (!EXPECTED_ERRORS.some((type) => error instanceof type)) unexpected.push(error);
      }),
    );
  };
  const background = (effect: Effect.Effect<unknown, unknown>) => {
    pending.push(harness.run(effect).catch((error: unknown) => unexpected.push(error)));
  };
  const server = () => harness.server;

  const ops: Array<[weight: number, run: () => void | Promise<void>]> = [
    [4, () => background(server().upsert(players, player(pick(playerIds), { name: `server ${random()}`, volume: Math.floor(random() * 100) })))],
    [2, () => background(server().delete(players, pick(playerIds)))],
    [3, () => background(server().upsert(counters, { id: pick(counterIds), count: Math.floor(random() * 1000) }))],
    [
      2,
      () =>
        background(
          server().write(
            Effect.gen(function* () {
              const id = pick(playerIds);
              const current = yield* server().get(players, id);
              yield* server().upsert(players, player(id, { tags: [...(current?.tags ?? []), String(seed)].slice(-3) }));
              yield* server().upsert(counters, { id: pick(counterIds), count: -1 });
              yield* Effect.yieldNow;
              if (chance(0.5)) yield* server().delete(players, pick(playerIds));
            }),
          ),
        ),
    ],
    // A write that fails must leave no trace.
    [
      1,
      () =>
        background(
          server()
            .write(Effect.andThen(server().upsert(players, player(pick(playerIds), { name: "rolled back" })), Effect.fail("boom")))
            .pipe(Effect.ignore),
        ),
    ],
    [
      0.5,
      () =>
        background(
          server().replace(
            counters,
            counterIds.filter(() => chance(0.5)).map((id) => ({ id, count: id })),
          ),
        ),
    ],
    [
      4,
      () => {
        const client = pick(clients);
        const id = pick(playerIds);
        if (client.players.status === "ready" && !client.players.has(id)) track(client.players.insert(player(id, { name: `client ${random()}`, joined: new Date(seed) })));
      },
    ],
    [
      4,
      () => {
        const client = pick(clients);
        const id = pick(playerIds);
        if (!client.players.has(id)) return;
        track(
          client.players.update(id, (draft) => {
            draft.volume = Math.floor(random() * 100);
            draft.status = chance(0.5) ? { _tag: "Idle" } : { _tag: "Playing", track: `t${seed}`, positionSeconds: random() * 60 };
          }),
        );
      },
    ],
    [
      2,
      () => {
        const client = pick(clients);
        const id = pick(playerIds);
        if (client.players.has(id)) track(client.players.delete(id));
      },
    ],
    [
      2,
      () => {
        const client = pick(clients);
        const id = pick(playerIds);
        const counter = pick(counterIds);
        if (client.players.status !== "ready" || client.counters.status !== "ready" || client.players.has(id) || client.counters.has(counter)) return;
        const tx = createTransaction({ mutationFn: ({ transaction }) => client.client.applyTransaction(transaction) });
        tx.mutate(() => {
          client.players.insert(player(id));
          client.counters.insert({ id: counter, count: 0 });
        });
        track(tx);
      },
    ],
    [1, () => pick(clients).connection.dropNextBatches(1)],
    [
      1,
      async () => {
        const { connection } = pick(clients);
        connection.pause();
        await sleep(random() * 20);
        connection.resume();
      },
    ],
    [
      0.3,
      async () => {
        const client = pick(clients);
        await client.counters.cleanup();
        // Another cleanup may abandon this preload; that is expected.
        pending.push(client.counters.preload().catch((error: unknown) => (error instanceof Error && error.name === "AbortError" ? undefined : unexpected.push(error))));
      },
    ],
    [0.15, () => void pending.push(harness.startServer().catch((error: unknown) => unexpected.push(error)))],
  ];
  const totalWeight = ops.reduce((sum, [weight]) => sum + weight, 0);

  try {
    for (let step = 0; step < steps; step++) {
      let roll = random() * totalWeight;
      const op = ops.find(([weight]) => (roll -= weight) < 0) ?? ops[0]!;
      const result = op[1]();
      if (chance(0.3)) await result;
      if (chance(0.4)) await sleep(random() * 3);
    }

    await Promise.all(pending);
    for (const { connection } of clients) connection.resume();

    for (const client of clients) {
      await Promise.all([client.players.preload(), client.counters.preload()]);
      await expectMemoryInSync(harness, client, 10_000);
      expect(client.players.status).toBe("ready");
      expect(client.players.toArray.every((row) => row.$synced)).toBe(true);
      expect(client.counters.toArray.every((row) => row.$synced)).toBe(true);
    }
  } finally {
    console.error = originalConsoleError;
  }

  expect(unexpected).toEqual([]);
  // Collections log here when applying or decoding a change fails, which would be a bug.
  expect(consoleErrors.filter((args) => /failed to apply|cannot be decoded/.test(String((args as Array<unknown>)[0])))).toEqual([]);
}

describe("memory fuzz", () => {
  // MIRROR_FUZZ_SEEDS / MIRROR_FUZZ_STEPS scale the run up for local soak testing.
  const seeds = Number(process.env.MIRROR_FUZZ_SEEDS ?? 12);
  const steps = Number(process.env.MIRROR_FUZZ_STEPS ?? 150);
  for (let seed = 1; seed <= seeds; seed++) {
    it(`converges with random concurrent writes (seed ${seed})`, () => runScenario(seed, steps), 120_000);
  }
});
