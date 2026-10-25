import { createCollection } from "@tanstack/db";
import { Effect } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { album, albums, createHarness, eventually, expectInSync, rowsOf, sleep, song, stripVirtual, unmirrored, type AlbumRow, type Harness } from "../test/harness.js";
import { createMirrorClient, MirrorTimeoutError, mirrorCollectionOptions, type MirrorCollectionUtils } from "./index.js";

let harness: Harness;

afterEach(async () => {
  await harness?.dispose();
});

/** Records every visible state of a key across change events. */
const watchKey = <T extends object>(collection: { subscribeChanges: (cb: () => void) => { unsubscribe: () => void }; get: (key: any) => T | undefined }, key: string | number) => {
  const states: Array<Record<string, unknown> | undefined> = [];
  const capture = () => {
    const value = collection.get(key);
    states.push(value ? stripVirtual(value) : undefined);
  };
  const subscription = collection.subscribeChanges(capture);
  return { states, stop: () => subscription.unsubscribe() };
};

describe("loading", () => {
  it("loads existing rows and becomes ready", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1", { starred: true, extra: { tags: ["x"] } }), album("a2")]);
    await harness.insertSongs([song(1, "a1")]);

    const client = harness.connect();
    await Promise.all([client.albums.preload(), client.songs.preload()]);

    expect(client.albums.status).toBe("ready");
    expect(rowsOf(client.albums)).toEqual([album("a1", { starred: true, extra: { tags: ["x"] } }), album("a2")]);
    expect(rowsOf(client.songs)).toEqual([song(1, "a1")]);
    expect(client.albums.get("a1")?.$synced).toBe(true);
  });

  it("keeps changes committed while a snapshot is in flight", async () => {
    harness = await createHarness({ latency: () => Math.random() * 10 });
    await harness.insertAlbums([album("a1")]);

    const client = harness.connect();
    const ready = client.albums.preload();
    for (let i = 2; i <= 20; i++) {
      await harness.insertAlbums([album(`a${i}`)]);
      if (i % 3 === 0) await harness.exec(`UPDATE albums SET plays = plays + 1 WHERE id = 'a1'`);
      if (i % 5 === 0) await harness.exec(`DELETE FROM albums WHERE id = ?`, [`a${i - 1}`]);
    }
    await ready;

    await expectInSync(harness, client);
  });

  it("starts with an empty table", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await client.albums.preload();
    expect(client.albums.size).toBe(0);
  });

  it("loads large tables", async () => {
    harness = await createHarness();
    await harness.insertAlbums(Array.from({ length: 5_000 }, (_, i) => album(`a${i}`)));

    const client = harness.connect();
    await client.albums.preload();

    expect(client.albums.size).toBe(5_000);
  });

  it("loads a collection that does not start on its own once something reads it, without the columns the server omits", async () => {
    harness = await createHarness({ server: { omitColumns: { albums: ["extra", "plays"] } } });
    await harness.insertAlbums([album("a1", { extra: { tags: ["x"] }, plays: 2 })]);
    const connection = harness.transport.connect();
    const client = createMirrorClient({ transport: connection });
    const lazy = createCollection(mirrorCollectionOptions({ client, table: albums, omit: ["extra", "plays"], startSync: false }));
    expectTypeOf(lazy.toArray[0]!).not.toHaveProperty("extra");

    await sleep(20);
    expect(connection.requests).toEqual([]);

    const subscription = lazy.subscribeChanges(() => undefined);
    await eventually(() => expect(rowsOf(lazy)).toEqual([{ id: "a1", name: "Album a1", artistId: null, starred: null, created: null, slug: null }]));
    subscription.unsubscribe();
    await lazy.cleanup();
    client.dispose();
    connection.close();
  });

  it("errors when the server does not mirror the table", async () => {
    harness = await createHarness();
    const client = harness.connect();
    const collection = createCollection(mirrorCollectionOptions({ client: client.client, table: unmirrored }));

    await expect(collection.preload()).rejects.toThrow(/not mirrored/);
    expect(collection.status).toBe("error");
    await collection.cleanup();
  });

  it("reloads after cleanup", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();

    await client.albums.cleanup();
    await harness.insertAlbums([album("a2")]);
    await client.albums.preload();

    expect(rowsOf(client.albums)).toEqual([album("a1"), album("a2")]);
  });
});

describe("live changes", () => {
  it("applies inserts, updates and deletes made by the server", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await Promise.all([client.albums.preload(), client.songs.preload()]);

    await harness.insertAlbums([album("a1"), album("a2")]);
    await harness.insertSongs([song(1, "a1"), song(2, "a2")]);
    await expectInSync(harness, client);

    await harness.exec(`UPDATE albums SET name = 'Changed', starred = 1 WHERE id = 'a1'`);
    await harness.exec(`DELETE FROM albums WHERE id = 'a2'`);

    await eventually(() => {
      expect(rowsOf(client.albums)).toEqual([album("a1", { name: "Changed", starred: true })]);
      expect(rowsOf(client.songs)).toEqual([song(1, "a1")]);
    });
  });

  it("follows primary-key changes", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();

    await harness.exec(`UPDATE albums SET id = 'b1' WHERE id = 'a1'`);

    await eventually(() => expect(rowsOf(client.albums)).toEqual([album("b1", { name: "Album a1" })]));
  });

  it("emits change events", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await client.albums.preload();
    const events: Array<{ type: string; key: unknown }> = [];
    client.albums.subscribeChanges((changes) => events.push(...changes.map(({ type, key }) => ({ type, key }))));

    await harness.insertAlbums([album("a1")]);
    await eventually(() => expect(client.albums.has("a1")).toBe(true));
    await harness.exec(`UPDATE albums SET name = 'B' WHERE id = 'a1'`);
    await eventually(() => expect(client.albums.get("a1")?.name).toBe("B"));
    await harness.exec(`DELETE FROM albums WHERE id = 'a1'`);
    await eventually(() => expect(client.albums.has("a1")).toBe(false));

    expect(events).toEqual([
      { type: "insert", key: "a1" },
      { type: "update", key: "a1" },
      { type: "delete", key: "a1" },
    ]);
  });

  it("keeps several clients in sync", async () => {
    harness = await createHarness({ latency: () => Math.random() * 5 });
    const first = harness.connect();
    const second = harness.connect();
    await Promise.all([first.albums.preload(), second.albums.preload(), first.songs.preload(), second.songs.preload()]);

    await harness.insertAlbums([album("a1"), album("a2")]);
    await harness.insertSongs([song(1, "a1")]);

    await expectInSync(harness, first);
    await expectInSync(harness, second);
  });
});

describe("server commands", () => {
  it("lets callers wait for a position returned by a server-side write", async () => {
    harness = await createHarness({ latency: 5 });
    const client = harness.connect();
    await client.albums.preload();

    const position = await harness.write(
      Effect.gen(function* () {
        yield* harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`);
        return yield* harness.server.position;
      }),
    );
    await client.albums.utils.awaitPosition(position);

    expect(client.albums.has("a1")).toBe(true);
  });

  it("pulls the batch of an awaited position when it is lost", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await client.albums.preload();

    client.connection.dropNextBatches(1);
    const position = await harness.write(
      Effect.gen(function* () {
        yield* harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`);
        return yield* harness.server.position;
      }),
    );
    await client.albums.utils.awaitPosition(position, 2_000);

    expect(client.albums.has("a1")).toBe(true);
  });

  it("times out when the position never arrives", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await client.albums.preload();
    client.connection.pause();

    const position = await harness.write(Effect.andThen(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`), harness.server.position));

    await expect(client.albums.utils.awaitPosition(position, 50)).rejects.toBeInstanceOf(MirrorTimeoutError);
    // The write committed; the row shows up once the stream catches up.
    client.connection.resume();
    await eventually(() => expect(client.albums.has("a1")).toBe(true));
  });

  it("starts a garbage-collected collection again to wait for a position", async () => {
    harness = await createHarness();
    const client = harness.connect();
    const collection = createCollection(mirrorCollectionOptions({ client: client.client, table: albums, id: "collected-albums", gcTime: 1 }));
    collection.subscribeChanges(() => undefined).unsubscribe();
    await eventually(() => expect(collection.status).toBe("cleaned-up"));

    const position = await harness.write(Effect.andThen(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`), harness.server.position));
    await collection.utils.awaitPosition(position, 2_000);

    expect(collection.status).toBe("ready");
    expect(collection.has("a1")).toBe(true);
    await collection.cleanup();
  });

  it("does not wait on a collection that has never started", async () => {
    harness = await createHarness();
    const client = harness.connect();
    const lazy = createCollection(mirrorCollectionOptions({ client: client.client, table: albums, id: "lazy-albums", startSync: false }));

    const position = await harness.write(Effect.andThen(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`), harness.server.position));
    await lazy.utils.awaitPosition(position, 50);

    // Whatever reads it later loads it from after the write.
    expect(lazy.status).toBe("idle");
    await lazy.preload();
    expect(lazy.has("a1")).toBe(true);
    await lazy.cleanup();
  });

  it("waits for a position across a server restart", async () => {
    harness = await createHarness({ latency: 5 });
    const client = harness.connect();
    await client.albums.preload();

    await harness.startServer();
    const position = await harness.write(Effect.andThen(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`), harness.server.position));
    await client.albums.utils.awaitPosition(position);

    expect(client.albums.has("a1")).toBe(true);
    expect(client.client.epoch).toBe(harness.server.epoch);
  });

  it("throws on local writes, and follows the server", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();

    expect(() => client.albums.insert(album("a2"))).toThrow(/handler/i);
    expect(() => client.albums.update("a1", (draft) => void (draft.name = "Changed"))).toThrow(/handler/i);
    expect(() => client.albums.delete("a1")).toThrow(/handler/i);
    expect(rowsOf(client.albums)).toEqual([album("a1")]);

    await harness.exec(`UPDATE albums SET name = 'Server' WHERE id = 'a1'`);
    await eventually(() => expect(client.albums.get("a1")?.name).toBe("Server"));
  });
});

describe("stream recovery", () => {
  it("pulls missed changes when a batch is lost", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await client.albums.preload();

    client.connection.dropNextBatches(1);
    await harness.insertAlbums([album("a1")]);
    await client.connection.flushed();
    expect(client.albums.has("a1")).toBe(false);

    await harness.insertAlbums([album("a2")]);

    await eventually(() => expect(rowsOf(client.albums)).toEqual([album("a1"), album("a2")]));
    expect(client.connection.requests.filter((request) => request.type === "pull")).toHaveLength(1);
    // One per collection: recovering from the gap did not reload anything.
    expect(client.connection.requests.filter((request) => request.type === "snapshot")).toHaveLength(2);
  });

  it("recovers a lost batch that no later batch reveals through the heartbeat", async () => {
    harness = await createHarness();
    const client = harness.connect({ heartbeatMs: 50 });
    await client.albums.preload();

    client.connection.dropNextBatches(1);
    await harness.insertAlbums([album("a1")]);

    await eventually(() => expect(rowsOf(client.albums)).toEqual([album("a1")]));
    expect(client.connection.requests.filter((request) => request.type === "pull")).toHaveLength(1);
  });

  it("reloads when missed changes were pruned", async () => {
    harness = await createHarness({ server: { retainChanges: 2 } });
    await harness.insertAlbums([album("a0")]);
    const client = harness.connect();
    await Promise.all([client.albums.preload(), client.songs.preload()]);

    client.connection.dropNextBatches(10);
    for (let i = 1; i <= 10; i++) await harness.insertAlbums([album(`a${i}`)]);
    await harness.exec(`DELETE FROM albums WHERE id = 'a0'`);
    await client.connection.flushed();
    await harness.insertSongs([song(1, "a1")]);

    await expectInSync(harness, client);
    // Two initial loads plus a reload of each collection.
    expect(client.connection.requests.filter((request) => request.type === "snapshot")).toHaveLength(4);
  });

  it("keeps showing data while reloading", async () => {
    harness = await createHarness({ server: { retainChanges: 1 } });
    await harness.insertAlbums([album("a0")]);
    const client = harness.connect();
    await client.albums.preload();
    const watch = watchKey(client.albums, "a0");

    client.connection.dropNextBatches(5);
    for (let i = 1; i <= 5; i++) await harness.insertAlbums([album(`a${i}`)]);
    await client.connection.flushed();
    await harness.insertAlbums([album("a6")]);
    await eventually(() => expect(client.albums.size).toBe(7));
    watch.stop();

    expect(watch.states.every((state) => state !== undefined)).toBe(true);
    expect(client.albums.status).toBe("ready");
  });

  it("reloads when the server restarts", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();
    const firstEpoch = client.client.epoch!;

    await harness.startServer();
    await harness.insertAlbums([album("a2")]);

    await eventually(() => expect(rowsOf(client.albums)).toEqual([album("a1"), album("a2")]));
    expect(client.client.epoch).toBe(harness.server.epoch);
    expect(client.client.epoch).toBeGreaterThan(firstEpoch);
  });

  it("ignores batches still in flight from a replaced server", async () => {
    harness = await createHarness();
    const client = harness.connect();
    await Promise.all([client.albums.preload(), client.songs.preload()]);

    // A batch from the old server is still queued when the client reconnects to the new one.
    client.connection.pause();
    await harness.insertAlbums([album("a1")]);
    await harness.startServer();
    client.client.reset();
    await eventually(() => expect(client.client.epoch).toBe(harness.server.epoch));
    client.connection.resume();
    await client.connection.flushed();

    const snapshots = client.connection.requests.filter((request) => request.type === "snapshot").length;

    await harness.insertAlbums([album("a2")]);
    await expectInSync(harness, client);
    // The stale batch is checked with a hello but does not trigger another reload.
    expect(client.connection.requests.filter((request) => request.type === "snapshot")).toHaveLength(snapshots);
    expect(client.client.epoch).toBe(harness.server.epoch);
  });

  it("follows a restarted server whose epoch went backwards", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();
    const before = client.client.epoch!;

    // A replaced database file plus a clock that moved back.
    await harness.run(harness.sql.unsafe(`UPDATE __mirror_changes_meta SET value = 1`));
    const now = vi.spyOn(Date, "now").mockReturnValue(2);
    try {
      await harness.startServer();
    } finally {
      now.mockRestore();
    }
    expect(harness.server.epoch).toBeLessThan(before);

    // An idle client notices from pushed batches alone.
    await harness.insertAlbums([album("a2")]);
    await expectInSync(harness, client);
    expect(client.client.epoch).toBe(harness.server.epoch);
  });

  it("retries the initial load until the server is reachable", async () => {
    harness = await createHarness();
    const unreachable = harness.transport.connect();
    const transport = {
      request: ((request) => (attempts++ < 2 ? Promise.reject(new Error("main not ready")) : unreachable.request(request))) as typeof unreachable.request,
      subscribe: unreachable.subscribe,
    };
    let attempts = 0;
    const { createMirrorClient } = await import("./index.js");
    const client = createMirrorClient({ transport });
    const collection = createCollection(mirrorCollectionOptions({ client, table: albums }));
    await harness.insertAlbums([album("a1")]);

    await expect(collection.preload()).rejects.toThrow(/main not ready/);
    await eventually(() => expect(collection.status).toBe("ready"), 5_000);
    expect(rowsOf(collection)).toEqual([album("a1")]);

    await collection.cleanup();
    client.dispose();
    unreachable.close();
  });
});

describe("types", () => {
  it("derives row and key types from the drizzle table", async () => {
    harness = await createHarness();
    const client = harness.connect();

    expectTypeOf(client.albums.get).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(client.songs.get).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(client.albums.utils).toEqualTypeOf<MirrorCollectionUtils>();

    const options = mirrorCollectionOptions({ client: client.client, table: albums, id: "typed" });
    expectTypeOf(options.getKey).returns.toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof options.getKey>[0]>().toEqualTypeOf<AlbumRow>();
    expectTypeOf<AlbumRow["created"]>().toEqualTypeOf<Date | null>();
    expectTypeOf<AlbumRow["extra"]>().toEqualTypeOf<{ tags: Array<string> } | null>();

    await sleep(0);
  });
});
