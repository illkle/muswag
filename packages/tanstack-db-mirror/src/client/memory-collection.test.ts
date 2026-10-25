import { BasicIndex, createCollection, createLiveQueryCollection, eq } from "@tanstack/db";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { memoryTable } from "../memory/index.js";
import { album, createHarness, eventually, rowsOf, song, type Harness } from "../test/harness.js";
import { counters, createMemoryHarness, expectMemoryInSync, player, Player, players, type MemoryHarness } from "../test/memory-harness.js";
import { mirrorCollectionOptions, type MirrorKeyOf, type MirrorRowOf } from "./index.js";

let harness: MemoryHarness;
let sqlite: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  await sqlite?.dispose();
  sqlite = undefined;
});

describe("memory tables", () => {
  it("loads decoded rows and becomes ready", async () => {
    harness = await createMemoryHarness();
    await harness.run(harness.server.replace(players, [player("p1", { joined: new Date(42), status: { _tag: "Playing", track: "t", positionSeconds: 3 } }), player("p2")]));

    const client = harness.connect();
    await client.players.preload();

    expect(client.players.status).toBe("ready");
    expect(client.players.get("p1")?.joined).toEqual(new Date(42));
    expect(rowsOf(client.players)).toEqual(await harness.serverRows("players"));
  });

  it("follows server writes and keeps several clients in sync", async () => {
    harness = await createMemoryHarness({ latency: () => Math.random() * 5 });
    const clients = [harness.connect(), harness.connect()];
    await Promise.all(clients.flatMap((client) => [client.players.preload(), client.counters.preload()]));

    for (let i = 0; i < 20; i++) {
      await harness.run(
        harness.server.write(
          Effect.gen(function* () {
            yield* harness.server.upsert(counters, { id: i % 4, count: i });
            yield* harness.server.upsert(players, player(`p${i % 3}`, { volume: i }));
            if (i % 5 === 0) yield* harness.server.delete(players, `p${(i + 1) % 3}`);
          }),
        ),
      );
    }
    for (const client of clients) await expectMemoryInSync(harness, client);
  });

  it("throws on local writes, and follows the server", async () => {
    harness = await createMemoryHarness();
    await harness.run(harness.server.upsert(players, player("p1")));
    const client = harness.connect();
    await client.players.preload();

    expect(() => client.players.insert(player("p2"))).toThrow(/handler/i);
    await harness.run(harness.server.upsert(players, player("p1", { name: "Renamed" })));
    await eventually(() => expect(client.players.get("p1")?.name).toBe("Renamed"));
  });

  it("lets callers wait for the position after a server write", async () => {
    harness = await createMemoryHarness({ latency: 5 });
    const client = harness.connect();
    await client.counters.preload();

    client.connection.dropNextBatches(1);
    await harness.run(harness.server.upsert(counters, { id: 1, count: 1 }));
    await client.counters.utils.awaitPosition(await harness.run(harness.server.position), 2_000);
    expect(client.counters.get(1)?.count).toBe(1);
  });

  it("reloads when changes it missed were pruned, and when the server restarts", async () => {
    harness = await createMemoryHarness({ server: { retainChanges: 2 } });
    await harness.run(harness.server.upsert(counters, { id: 0, count: 0 }));
    const client = harness.connect();
    await Promise.all([client.players.preload(), client.counters.preload()]);

    client.connection.dropNextBatches(10);
    for (let i = 1; i <= 10; i++) await harness.run(harness.server.upsert(counters, { id: i, count: i }));
    await client.connection.flushed();
    await harness.run(harness.server.delete(counters, 0));
    await expectMemoryInSync(harness, client);

    // A restarted process starts with empty tables.
    await harness.startServer();
    await harness.run(harness.server.upsert(players, player("fresh")));
    await expectMemoryInSync(harness, client);
    expect(client.counters.size).toBe(0);
  });

  it("notices a restart that sent nothing through the heartbeat", async () => {
    harness = await createMemoryHarness();
    await harness.run(harness.server.upsert(players, player("p1")));
    const client = harness.connect({ heartbeatMs: 50 });
    await client.players.preload();

    await harness.startServer();
    await eventually(() => expect(client.players.size).toBe(0));
  });

  it("skips rows it cannot decode", async () => {
    harness = await createMemoryHarness();
    await harness.run(harness.server.replace(players, [player("quiet", { volume: 5 }), player("loud", { volume: 90 })]));
    // A client whose schema is stricter than the server's, as after a version mismatch.
    const strict = memoryTable("players", Schema.Struct({ ...Player.fields, volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 10 })) }), { primaryKey: "id" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = harness.connect();
    const collection = createCollection(mirrorCollectionOptions({ client: client.client, table: strict, id: "strict-players" }));
    await collection.preload();

    expect([...collection.keys()]).toEqual(["quiet"]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    await collection.cleanup();
  });

  it("derives row and key types from the schema", () => {
    expectTypeOf<MirrorRowOf<typeof players>>().toEqualTypeOf<Player>();
    expectTypeOf<MirrorKeyOf<typeof players>>().toEqualTypeOf<string>();
    expectTypeOf<MirrorKeyOf<typeof counters>>().toEqualTypeOf<number>();
    expectTypeOf<ReturnType<typeof mirrorCollectionOptions<typeof players>>["getKey"]>().toEqualTypeOf<(item: Player) => string>();
  });
});

describe("memory and SQLite together", () => {
  it("joins collections of both sources in one live query", async () => {
    harness = await createMemoryHarness();
    sqlite = await createHarness();
    await sqlite.insertAlbums([album("a1")]);
    await sqlite.insertSongs([song(1, "a1", { title: "First" }), song(2, "a1", { title: "Second" })]);
    await harness.run(harness.server.upsert(counters, { id: 2, count: 7 }));

    const memory = harness.connect();
    const library = sqlite.connect();
    memory.counters.createIndex((row) => row.id, { indexType: BasicIndex });
    library.songs.createIndex((row) => row.id, { indexType: BasicIndex });
    const plays = createLiveQueryCollection((q) =>
      q
        .from({ counter: memory.counters })
        .join({ song: library.songs }, ({ counter, song }) => eq(counter.id, song.id), "inner")
        .select(({ counter, song }) => ({ id: song.id, title: song.title, count: counter.count })),
    );
    try {
      await plays.preload();
      expect(rowsOf(plays)).toEqual([{ id: 2, title: "Second", count: 7 }]);

      await harness.run(harness.server.upsert(counters, { id: 1, count: 3 }));
      await sqlite.exec(`UPDATE songs SET title = 'Renamed' WHERE id = 2`);
      await eventually(() =>
        expect(rowsOf(plays)).toEqual([
          { id: 1, title: "First", count: 3 },
          { id: 2, title: "Renamed", count: 7 },
        ]),
      );
    } finally {
      await plays.cleanup();
    }
  });
});
