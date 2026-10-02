import { createCollection, createTransaction } from "@tanstack/db";
import { Effect } from "effect";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { album, albums, createHarness, eventually, expectInSync, rowsOf, sleep, song, stripVirtual, unmirrored, type AlbumRow, type Harness } from "../test/harness.js";
import { MirrorRemoteError, MirrorTimeoutError, mirrorCollectionOptions, type MirrorCollectionUtils } from "./index.js";

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

    await first.albums.insert(album("a1")).isPersisted.promise;
    await second.songs.insert(song(1, "a1")).isPersisted.promise;
    await harness.insertAlbums([album("a2")]);

    await expectInSync(harness, first);
    await expectInSync(harness, second);
  });
});

describe("mutations", () => {
  it("writes optimistic inserts to SQLite without flicker", async () => {
    harness = await createHarness({ latency: 5 });
    const client = harness.connect();
    await client.albums.preload();
    const watch = watchKey(client.albums, "a1");

    const tx = client.albums.insert(album("a1", { starred: true }));
    expect(client.albums.get("a1")?.$synced).toBe(false);
    await tx.isPersisted.promise;
    watch.stop();

    expect(client.albums.get("a1")?.$synced).toBe(true);
    expect(await harness.dbRows("albums")).toEqual([album("a1", { starred: true })]);
    expect(watch.states.every((state) => state !== undefined)).toBe(true);
  });

  it("writes updates and deletes", async () => {
    harness = await createHarness({ latency: 2 });
    await harness.insertAlbums([album("a1"), album("a2")]);
    const client = harness.connect();
    await client.albums.preload();
    const watch = watchKey(client.albums, "a1");

    await client.albums.update("a1", (draft) => {
      draft.name = "Renamed";
      draft.extra = { tags: ["new"] };
    }).isPersisted.promise;
    watch.stop();
    await client.albums.delete("a2").isPersisted.promise;

    expect(await harness.dbRows("albums")).toEqual([album("a1", { name: "Renamed", extra: { tags: ["new"] } })]);
    expect(rowsOf(client.albums)).toEqual(await harness.dbRows("albums"));
    // Never reverts to the old name while the update round-trips.
    expect(watch.states.map((state) => state?.name)).not.toContain("Album a1");
  });

  it("syncs values the server fills in", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.songs.preload();

    await client.songs.insert({ id: 1, albumId: "a1", title: "S", rating: null, updatedAt: null }).isPersisted.promise;
    await client.songs.update(1, (draft) => {
      draft.title = "S2";
    }).isPersisted.promise;

    const row = client.songs.get(1);
    expect(row?.title).toBe("S2");
    expect(typeof row?.updatedAt).toBe("number");
    expect(rowsOf(client.songs)).toEqual(await harness.dbRows("songs"));
  });

  it("rolls back mutations the server rejects", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();

    // Not visible to the client yet, so the optimistic insert conflicts on the server.
    await harness.run(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a2', 'Server')`));
    const tx = client.albums.insert(album("a2", { name: "Client" }));

    await expect(tx.isPersisted.promise).rejects.toBeInstanceOf(MirrorRemoteError);
    expect(client.albums.has("a2")).toBe(false);

    await harness.run(harness.server.flush);
    await eventually(() => expect(client.albums.get("a2")?.name).toBe("Server"));
  });

  it("rolls back an update of a row the server already deleted", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();
    client.connection.pause();
    await harness.exec(`DELETE FROM albums WHERE id = 'a1'`);

    const tx = client.albums.update("a1", (draft) => {
      draft.name = "Too late";
    });
    await expect(tx.isPersisted.promise).rejects.toThrow(/does not exist/);
    expect(client.albums.get("a1")?.name).toBe("Album a1");

    client.connection.resume();
    await eventually(() => expect(client.albums.has("a1")).toBe(false));
  });

  it("writes a transaction across collections atomically", async () => {
    harness = await createHarness({ latency: 2 });
    const client = harness.connect();
    await Promise.all([client.albums.preload(), client.songs.preload()]);

    const tx = createTransaction({ mutationFn: ({ transaction }) => client.client.applyTransaction(transaction) });
    tx.mutate(() => {
      client.albums.insert(album("a1"));
      client.songs.insert(song(1, "a1"));
      client.songs.insert(song(2, "a1"));
    });
    await tx.isPersisted.promise;

    expect(rowsOf(client.albums)).toEqual([album("a1")]);
    expect(rowsOf(client.songs)).toEqual([song(1, "a1"), song(2, "a1")]);
    await expectInSync(harness, client);

    const failing = createTransaction({ mutationFn: ({ transaction }) => client.client.applyTransaction(transaction) });
    failing.mutate(() => {
      client.albums.insert(album("a2"));
      client.songs.insert(song(3, "missing-album"));
    });
    await expect(failing.isPersisted.promise).rejects.toThrow(/FOREIGN KEY/);

    expect(client.albums.has("a2")).toBe(false);
    expect(client.songs.has(3)).toBe(false);
    expect(await harness.dbRows("albums")).toEqual([album("a1")]);
  });

  it("rejects transactions that touch collections of another client", async () => {
    harness = await createHarness();
    const first = harness.connect();
    const second = harness.connect();
    await Promise.all([first.albums.preload(), second.albums.preload()]);

    const tx = createTransaction({ mutationFn: ({ transaction }) => first.client.applyTransaction(transaction) });
    tx.mutate(() => {
      second.albums.insert(album("a1"));
    });

    await expect(tx.isPersisted.promise).rejects.toThrow(/not a mirror collection of this client/);
    expect(await harness.dbRows("albums")).toEqual([]);
  });

  it("waits for a collection that is still loading before writing", async () => {
    harness = await createHarness({ latency: 10 });
    const client = harness.connect();

    const tx = client.albums.insert(album("a1"));
    await tx.isPersisted.promise;

    expect(client.albums.status).toBe("ready");
    expect(rowsOf(client.albums)).toEqual([album("a1")]);
  });

  it("starts a lazily synced collection before writing", async () => {
    harness = await createHarness();
    const client = harness.connect();
    const lazy = createCollection(mirrorCollectionOptions({ client: client.client, table: albums, id: "lazy-albums", startSync: false }));
    expect(lazy.status).toBe("idle");

    await lazy.insert(album("a1")).isPersisted.promise;

    expect(lazy.status).toBe("ready");
    expect(rowsOf(lazy)).toEqual([album("a1")]);
    await lazy.cleanup();
  });

  it("times out when the change never comes back", async () => {
    harness = await createHarness();
    const client = harness.connect({ mutationTimeoutMs: 50 });
    await client.albums.preload();
    client.connection.pause();

    const tx = client.albums.insert(album("a1"));

    await expect(tx.isPersisted.promise).rejects.toBeInstanceOf(MirrorTimeoutError);
    // The write itself committed; the row shows up once the stream catches up.
    client.connection.resume();
    await eventually(() => expect(client.albums.get("a1")?.$synced).toBe(true));
  });

  it("serializes concurrent mutations on the same row", async () => {
    harness = await createHarness({ latency: () => Math.random() * 5 });
    await harness.insertAlbums([album("a1")]);
    const client = harness.connect();
    await client.albums.preload();

    const txs = Array.from({ length: 10 }, (_, i) =>
      client.albums.update("a1", (draft) => {
        draft.plays = i + 1;
      }),
    );
    await Promise.all(txs.map((tx) => tx.isPersisted.promise));

    await expectInSync(harness, client);
    expect(client.albums.get("a1")?.plays).toBe(10);
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

  it("pulls a lost batch when a mutation reveals the stream is behind", async () => {
    harness = await createHarness();
    const client = harness.connect({ mutationTimeoutMs: 5_000 });
    await client.albums.preload();

    client.connection.dropNextBatches(1);
    await client.albums.insert(album("a1")).isPersisted.promise;

    expect(client.albums.get("a1")?.$synced).toBe(true);
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
    const client = harness.connect({ mutationTimeoutMs: 5_000 });
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

    await client.albums.insert(album("a3")).isPersisted.promise;
    await expectInSync(harness, client);
  });

  it("completes mutations across a server restart", async () => {
    harness = await createHarness({ latency: 5 });
    const client = harness.connect();
    await client.albums.preload();

    await harness.startServer();
    await client.albums.insert(album("a1")).isPersisted.promise;

    await expectInSync(harness, client);
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
