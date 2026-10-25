import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { mulberry32, sleep } from "../test/harness.js";
import { counters, createMemoryHarness, expectMemoryInSync, player, players, type MemoryClient, type MemoryHarness } from "../test/memory-harness.js";
import { MirrorClientDisposedError, MirrorTimeoutError } from "./index.js";

// A wait times out when its batch is held back long enough, and ends when its collection is cleaned up.
const EXPECTED_ERRORS = [MirrorTimeoutError, MirrorClientDisposedError];

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
  const clients: Array<MemoryClient> = [0, 1, 2].map(() => harness.connect({ positionTimeoutMs: 2_000, heartbeatMs: 100 }));

  const unexpected: Array<unknown> = [];
  const consoleErrors: Array<unknown> = [];
  const originalConsoleError = console.error;
  console.error = (...args: Array<unknown>) => consoleErrors.push(args);

  const pending: Array<Promise<unknown>> = [];
  const background = (effect: Effect.Effect<unknown, unknown>) => {
    pending.push(harness.run(effect).catch((error: unknown) => unexpected.push(error)));
  };
  const server = () => harness.server;
  /** Runs `effect` as one write, the way a main-process command does, and has a collection of a client wait for its position. */
  const command = (effect: Effect.Effect<unknown>) => {
    const client = pick(clients);
    const collection = chance(0.5) ? client.players : client.counters;
    const current = server();
    pending.push(
      harness.run(Effect.andThen(current.write(effect), current.position)).then(
        (position) =>
          collection.utils.awaitPosition(position).catch((error: unknown) => {
            if (!EXPECTED_ERRORS.some((type) => error instanceof type)) unexpected.push(error);
          }),
        (error: unknown) => unexpected.push(error),
      ),
    );
  };

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
    [4, () => command(server().upsert(players, player(pick(playerIds), { name: `command ${random()}`, joined: new Date(seed) })))],
    [
      4,
      () =>
        command(
          server().upsert(
            players,
            player(pick(playerIds), {
              volume: Math.floor(random() * 100),
              status: chance(0.5) ? { _tag: "Idle" } : { _tag: "Playing", track: `t${seed}`, positionSeconds: random() * 60 },
            }),
          ),
        ),
    ],
    [2, () => command(server().delete(players, pick(playerIds)))],
    [2, () => command(Effect.andThen(server().upsert(players, player(pick(playerIds))), server().upsert(counters, { id: pick(counterIds), count: 0 })))],
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
