import { createTransaction, type Transaction } from "@tanstack/db";
import { afterEach, describe, expect, it } from "vitest";

import { album, createHarness, expectInSync, mulberry32, sleep, song, type ConnectedClient, type Harness } from "../test/harness.js";
import { MirrorClientDisposedError, MirrorRemoteError, MirrorTimeoutError } from "./index.js";

const EXPECTED_ERRORS = [MirrorRemoteError, MirrorTimeoutError, MirrorClientDisposedError];

let harness: Harness;

afterEach(async () => {
  await harness?.dispose();
});

async function runScenario(seed: number, steps: number) {
  const random = mulberry32(seed);
  const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;
  const albumIds = Array.from({ length: 25 }, (_, i) => `a${i}`);
  let nextSongId = 1;

  harness = await createHarness({ latency: () => random() * 4, server: { retainChanges: 15 } });
  const clients: Array<ConnectedClient> = [0, 1, 2].map(() => harness.connect({ mutationTimeoutMs: 2_000, heartbeatMs: 100 }));

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
  const background = (promise: Promise<unknown>) => {
    pending.push(promise.catch((error: unknown) => unexpected.push(error)));
  };

  const ops: Array<[weight: number, run: () => void | Promise<void>]> = [
    [4, () => background(harness.exec(`INSERT OR IGNORE INTO albums (id, name) VALUES (?, ?)`, [pick(albumIds), `server ${random()}`]))],
    [3, () => background(harness.exec(`UPDATE albums SET name = ?, starred = ? WHERE id = ?`, [`renamed ${random()}`, chance(0.5) ? 1 : 0, pick(albumIds)]))],
    [2, () => background(harness.exec(`DELETE FROM albums WHERE id = ?`, [pick(albumIds)]))],
    [1, () => background(harness.exec(`UPDATE albums SET plays = plays + 1 WHERE id > ?`, [pick(albumIds)]))],
    [3, () => background(harness.exec(`INSERT INTO songs (id, album_id, title) SELECT ?, id, 'server song' FROM albums WHERE id = ?`, [nextSongId++, pick(albumIds)]))],
    [1, () => background(harness.run(harness.sql.unsafe(`UPDATE songs SET title = 'unflushed' WHERE id % 2 = 0`)).then(() => harness.run(harness.server.flush)))],
    [
      4,
      () => {
        const client = pick(clients);
        const id = pick(albumIds);
        if (client.albums.status === "ready" && !client.albums.has(id)) track(client.albums.insert(album(id, { name: `client ${random()}` })));
      },
    ],
    [
      4,
      () => {
        const client = pick(clients);
        const id = pick(albumIds);
        if (!client.albums.has(id)) return;
        track(
          client.albums.update(id, (draft) => {
            draft.plays = Math.floor(random() * 100);
            draft.extra = { tags: [String(seed)] };
          }),
        );
      },
    ],
    [
      2,
      () => {
        const client = pick(clients);
        const id = pick(albumIds);
        if (client.albums.has(id)) track(client.albums.delete(id));
      },
    ],
    [
      2,
      () => {
        const client = pick(clients);
        const id = pick(albumIds);
        if (client.albums.status !== "ready" || client.songs.status !== "ready" || client.albums.has(id)) return;
        const tx = createTransaction({ mutationFn: ({ transaction }) => client.client.applyTransaction(transaction) });
        tx.mutate(() => {
          client.albums.insert(album(id));
          client.songs.insert(song(nextSongId++, id));
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
        await client.songs.cleanup();
        // Another cleanup may abandon this preload; that is expected.
        pending.push(client.songs.preload().catch((error: unknown) => (error instanceof Error && error.name === "AbortError" ? undefined : unexpected.push(error))));
      },
    ],
    [0.15, () => background(harness.startServer())],
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
    await harness.run(harness.server.flush);

    for (const client of clients) {
      await Promise.all([client.albums.preload(), client.songs.preload()]);
      await expectInSync(harness, client, 10_000);
      expect(client.albums.status).toBe("ready");
      expect(client.albums.toArray.every((row) => row.$synced)).toBe(true);
      expect(client.songs.toArray.every((row) => row.$synced)).toBe(true);
    }
  } finally {
    console.error = originalConsoleError;
  }

  expect(unexpected).toEqual([]);
  // Collections log here when applying a change throws, which would be a bug.
  expect(consoleErrors.filter((args) => String((args as Array<unknown>)[0]).includes("failed to apply"))).toEqual([]);
}

describe("fuzz", () => {
  // MIRROR_FUZZ_SEEDS / MIRROR_FUZZ_STEPS scale the run up for local soak testing.
  const seeds = Number(process.env.MIRROR_FUZZ_SEEDS ?? 12);
  const steps = Number(process.env.MIRROR_FUZZ_STEPS ?? 150);
  for (let seed = 1; seed <= seeds; seed++) {
    it(`converges with random concurrent writes (seed ${seed})`, () => runScenario(seed, steps), 120_000);
  }
});
