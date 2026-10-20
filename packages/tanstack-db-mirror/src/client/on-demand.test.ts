import { BasicIndex, createCollection, createLiveQueryCollection, eq, inArray } from "@tanstack/db";
import { afterEach, describe, expect, it } from "vitest";

import { album, albums, createHarness, eventually, mulberry32, sleep, song, songs, stripVirtual, type ConnectedClient, type Harness, type SongRow } from "../test/harness.js";
import { createMirrorClient, mirrorCollectionOptions } from "./index.js";

let harness: Harness;
let created: Array<{ cleanup: () => Promise<void> }> = [];
afterEach(async () => {
  // Live queries before the collections they read, and those before the server goes.
  for (const collection of created.reverse()) await collection.cleanup();
  created = [];
  await harness?.dispose();
});

const track = <T extends { cleanup: () => Promise<void> }>(collection: T): T => {
  created.push(collection);
  return collection;
};
const live = ((config: Parameters<typeof createLiveQueryCollection>[0]) => track(createLiveQueryCollection(config))) as typeof createLiveQueryCollection;

const setup = async (songCount = 50, connectOptions: Parameters<Harness["connect"]>[0] = {}) => {
  harness = await createHarness({ server: { keyOnlyTables: ["songs"] } });
  await harness.insertAlbums([album("a1"), album("a2"), album("a3")]);
  await harness.insertSongs(Array.from({ length: songCount }, (_, i) => song(i + 1, `a${(i % 3) + 1}`, { title: `Song ${String(i + 1).padStart(3, "0")}` })));
  const connected = harness.connect(connectOptions);
  // TanStack DB loads an ordered window lazily only through an index that compares text the way the query does.
  const collection = track(
    createCollection(mirrorCollectionOptions({ client: connected.client, table: songs, syncMode: "on-demand", id: "on-demand-songs", autoIndex: "eager", defaultIndexType: BasicIndex })),
  );
  return { collection, connected };
};

const ids = (rows: ReadonlyArray<SongRow>) => rows.map(({ id }) => id);
const sortedIds = (rows: ReadonlyArray<SongRow>) => ids(rows).sort((a, b) => a - b);
const queries = (connected: ConnectedClient) => connected.connection.requests.filter((request) => request.type === "query").length;
const selectIds = async (statement: string, params: ReadonlyArray<unknown> = []) => (await harness.run(harness.sql.unsafe<{ id: number }>(statement, params))).map(({ id }) => id);

describe("on-demand mirror collection", () => {
  it("holds only the rows a query asks for, and follows changes to them", async () => {
    const { collection } = await setup();
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    await album2.preload();

    expect(album2.size).toBe(17);
    expect(collection.size).toBe(17);

    await harness.insertSongs([song(100, "a2"), song(101, "a1")]);
    await harness.exec(`UPDATE songs SET title = 'Renamed' WHERE id = 2`);
    await harness.exec(`DELETE FROM songs WHERE id = 5`);
    // One song moves into the album, one out of it.
    await harness.exec(`UPDATE songs SET album_id = 'a2' WHERE id = 1`);
    await harness.exec(`UPDATE songs SET album_id = 'a3' WHERE id = 8`);
    await eventually(async () => {
      expect(sortedIds(album2.toArray)).toEqual(await selectIds(`SELECT id FROM songs WHERE album_id = 'a2' ORDER BY id`));
      expect(collection.get(2)?.title).toBe("Renamed");
    });
    expect(sortedIds(album2.toArray)).toContain(100);
    // Songs of other albums are no query's business.
    expect(collection.size).toBe(album2.size);
    for (const id of [101, 5, 8]) expect(collection.get(id)).toBeUndefined();
  });

  it("loads a window of an ordered query, moves it, and lets go of the rows no query holds", async () => {
    const { collection } = await setup();
    const window = live({
      query: (q) =>
        q
          .from({ song: collection })
          .orderBy(({ song }) => song.title, { stringSort: "lexical" })
          .limit(10)
          .offset(0),
    });
    await window.preload();
    expect(ids(window.toArray)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await window.utils.setWindow({ offset: 30, limit: 10 });
    await eventually(() => expect(ids(window.toArray)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]));

    // A song that sorts into the window comes in, one past its end does not.
    await harness.insertSongs([song(200, "a1", { title: "Song 035b" }), song(201, "a1", { title: "Song 999" })]);
    await eventually(() => expect(ids(window.toArray)).toEqual([31, 32, 33, 34, 35, 200, 36, 37, 38, 39]));
    expect(collection.get(201)).toBeUndefined();

    // A deleted song makes room for the next one.
    await harness.exec(`DELETE FROM songs WHERE id = 33`);
    await eventually(() => expect(ids(window.toArray)).toEqual([31, 32, 34, 35, 200, 36, 37, 38, 39, 40]));

    await window.cleanup();
    await eventually(() => expect(collection.size).toBe(0));
  });

  it("grows a window from the start, the way an infinite list does", async () => {
    const { collection } = await setup(120);
    const pages = live({
      query: (q) =>
        q
          .from({ song: collection })
          .orderBy(({ song }) => song.title, { stringSort: "lexical" })
          .limit(41)
          .offset(0),
    });
    await pages.preload();
    expect(pages.size).toBe(41);
    await pages.utils.setWindow({ offset: 0, limit: 81 });
    await eventually(() => expect(pages.size).toBe(81));
    await pages.utils.setWindow({ offset: 0, limit: 121 });
    await eventually(() => expect(ids(pages.toArray)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1)));
  });

  it("loads the songs of the albums a join picks, and follows the albums", async () => {
    const { collection, connected } = await setup();
    await harness.exec(`UPDATE albums SET artist_id = 'artist' WHERE id IN ('a1', 'a3')`);
    const albumCollection = track(createCollection(mirrorCollectionOptions({ client: connected.client, table: albums, id: "join-albums", autoIndex: "eager", defaultIndexType: BasicIndex })));
    const discography = live({
      query: (q) =>
        q
          .from({ song: collection })
          .innerJoin({ album: albumCollection }, ({ song, album }) => eq(song.albumId, album.id))
          .where(({ album }) => eq(album.artistId, "artist"))
          .select(({ song }) => song),
    });
    await discography.preload();
    expect(discography.size).toBe(33);
    expect(collection.size).toBe(33);

    const expected = () => selectIds(`SELECT songs.id FROM songs JOIN albums ON albums.id = songs.album_id WHERE albums.artist_id = 'artist' ORDER BY songs.id`);
    await harness.exec(`UPDATE albums SET artist_id = 'artist' WHERE id = 'a2'`);
    await eventually(async () => expect(sortedIds(discography.toArray as Array<SongRow>)).toEqual(await expected()));
    expect(discography.size).toBe(50);

    await harness.insertSongs([song(300, "a1")]);
    await harness.exec(`UPDATE albums SET artist_id = NULL WHERE id = 'a1'`);
    await eventually(async () => expect(sortedIds(discography.toArray as Array<SongRow>)).toEqual(await expected()));
    expect(discography.size).toBe(33);
  });

  it("looks rows up by key", async () => {
    const { collection } = await setup();
    const picked = live({ query: (q) => q.from({ song: collection }).where(({ song }) => inArray(song.id, [3, 9, 27])) });
    await picked.preload();
    expect(sortedIds(picked.toArray)).toEqual([3, 9, 27]);

    await harness.exec(`UPDATE songs SET title = 'Picked' WHERE id IN (9, 10)`);
    await eventually(() => expect(collection.get(9)?.title).toBe("Picked"));
    expect(collection.get(10)).toBeUndefined();
    expect(collection.size).toBe(3);
  });

  it("keeps a row two queries hold until both let go of it", async () => {
    const { collection } = await setup();
    const album1 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a1")) });
    const picked = live({ query: (q) => q.from({ song: collection }).where(({ song }) => inArray(song.id, [1, 2])) });
    await Promise.all([album1.preload(), picked.preload()]);
    expect(collection.size).toBe(18);

    await album1.cleanup();
    await eventually(() => expect(sortedIds(collection.toArray)).toEqual([1, 2]));
    // A refresh does not bring back what was let go of.
    await harness.exec(`UPDATE songs SET title = 'Renamed' WHERE id IN (1, 4)`);
    await eventually(() => expect(collection.get(1)?.title).toBe("Renamed"));
    expect(sortedIds(collection.toArray)).toEqual([1, 2]);

    await picked.cleanup();
    await eventually(() => expect(collection.size).toBe(0));
  });

  it("writes only the rows a refresh finds changed, and reaches the position a write returns", async () => {
    const { collection } = await setup();
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    await album2.preload();
    const written: Array<number> = [];
    const subscription = collection.subscribeChanges((changes) => written.push(...changes.map((change) => change.key as number)));

    await harness.exec(`UPDATE songs SET title = 'Renamed' WHERE id IN (2, 3)`);
    await collection.utils.awaitPosition(await harness.run(harness.server.position));

    // Song 3 is in another album; every song of the album came back from the refresh, only song 2 changed.
    expect(collection.get(2)?.title).toBe("Renamed");
    expect(written).toEqual([2]);
    subscription.unsubscribe();
  });

  it("refreshes a burst of changes a few times, not once per batch", async () => {
    const { collection, connected } = await setup();
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    await album2.preload();
    const before = queries(connected);

    const started = Date.now();
    for (let i = 0; i < 40; i++) await harness.insertSongs([song(1000 + i, "a2")]);
    const elapsed = Date.now() - started;
    await collection.utils.awaitPosition(await harness.run(harness.server.position));

    expect(album2.size).toBe(57);
    // At most one refresh per 250 ms, plus the one right away and the one after the last batch.
    expect(queries(connected) - before).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 2);
  });

  it("refreshes a subset whose rows changed while it loaded", async () => {
    const { collection, connected } = await setup(50, { latency: 15 });
    const album1 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a1")) });
    const ready = album1.preload();
    // Changes made after the query reached the server, and before its answer came back.
    await eventually(() => expect(queries(connected)).toBeGreaterThan(0));
    await sleep(20);
    await harness.exec(`UPDATE songs SET title = 'Changed' WHERE id = 1`);
    await harness.insertSongs([song(400, "a1")]);
    await harness.exec(`DELETE FROM songs WHERE id = 4`);
    await ready;

    await eventually(async () => {
      expect(sortedIds(album1.toArray)).toEqual(await selectIds(`SELECT id FROM songs WHERE album_id = 'a1' ORDER BY id`));
      expect(collection.get(1)?.title).toBe("Changed");
    });
  });

  it("writes nothing for a load that answers after its query went away", async () => {
    const { collection, connected } = await setup(50, { latency: 15 });
    const album1 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a1")) });
    void album1.preload().catch(() => undefined);
    await eventually(() => expect(queries(connected)).toBeGreaterThan(0));
    await album1.cleanup();
    // The query's answer takes two hops of 15 ms.
    await sleep(60);
    expect(connected.connection.requests.at(-1)?.type).toBe("query");
    expect(collection.size).toBe(0);
  });

  it("keeps its subsets through a reset and reads them again", async () => {
    const { collection, connected } = await setup(50, { heartbeatMs: 20 });
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    await album2.preload();

    // Changes the stream never delivers, then a new server: the client resets.
    connected.connection.pause();
    await harness.insertSongs([song(500, "a2")]);
    await harness.exec(`DELETE FROM songs WHERE id = 2`);
    await harness.startServer();
    connected.connection.resume();
    await eventually(async () => expect(sortedIds(album2.toArray)).toEqual(await selectIds(`SELECT id FROM songs WHERE album_id = 'a2' ORDER BY id`)));
    expect(collection.get(500)).toBeDefined();

    // And it follows the new server's changes.
    await harness.exec(`UPDATE songs SET title = 'After' WHERE id = 5`);
    await collection.utils.awaitPosition(await harness.run(harness.server.position));
    expect(collection.get(5)?.title).toBe("After");

    // A reset the client decides on alone, after changes it missed, refreshes the subsets too.
    await harness.run(harness.sql.unsafe(`UPDATE songs SET title = 'Unbroadcast' WHERE id = 8`));
    connected.client.reset();
    await eventually(() => expect(collection.get(8)?.title).toBe("Unbroadcast"));
  });

  it("reads its subsets again after a new server takes over while a refresh is out", async () => {
    harness = await createHarness({ server: { keyOnlyTables: ["songs"] } });
    await harness.insertAlbums([album("a1"), album("a2")]);
    await harness.insertSongs(Array.from({ length: 10 }, (_, i) => song(i + 1, `a${(i % 2) + 1}`)));
    // A transport whose queries can be held back.
    const connection = harness.transport.connect();
    let held: Array<() => void> | null = null;
    const client = createMirrorClient({
      heartbeatMs: 0,
      transport: {
        subscribe: connection.subscribe,
        request: async (request) => {
          if (held && request.type === "query") await new Promise<void>((resolve) => held!.push(resolve));
          return connection.request(request);
        },
      },
    });
    track({
      cleanup: async () => {
        client.dispose();
        connection.close();
      },
    });
    const collection = track(createCollection(mirrorCollectionOptions({ client, table: songs, syncMode: "on-demand", id: "held-songs" })));
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    await album2.preload();

    held = [];
    await harness.exec(`UPDATE songs SET title = 'First' WHERE id = 2`);
    await eventually(() => expect(held).toHaveLength(1));
    // The refresh is out when the server restarts, after a change it never broadcasts.
    await harness.run(harness.sql.unsafe(`UPDATE songs SET title = 'Missed' WHERE id = 4`));
    await harness.startServer();
    client.reset();
    await eventually(() => expect(client.epoch).toBe(harness.server.epoch));
    await sleep(10);
    const release = held;
    held = null;
    for (const resolve of release) resolve();

    await eventually(() => {
      expect(collection.get(2)?.title).toBe("First");
      expect(collection.get(4)?.title).toBe("Missed");
    });
  });

  it("matches the database after random changes made while it loads and refreshes", async () => {
    const random = mulberry32(7);
    // Responses come back out of order.
    const { collection } = await setup(300, { latency: () => Math.floor(random() * 4) });
    const window = live({
      query: (q) =>
        q
          .from({ song: collection })
          .where(({ song }) => eq(song.albumId, "a1"))
          .orderBy(({ song }) => song.title, { stringSort: "lexical" })
          .orderBy(({ song }) => song.id, { stringSort: "lexical" })
          .limit(25)
          .offset(0),
    });
    const album2 = live({ query: (q) => q.from({ song: collection }).where(({ song }) => eq(song.albumId, "a2")) });
    const ready = Promise.all([window.preload(), album2.preload()]);
    const title = () => `Song ${String(Math.floor(random() * 400)).padStart(3, "0")}`;
    const albumId = () => `a${1 + Math.floor(random() * 3)}`;
    let next = 1000;
    for (let step = 0; step < 120; step++) {
      const roll = random();
      const id = 1 + Math.floor(random() * 300);
      if (roll < 0.3) await harness.exec(`UPDATE songs SET title = ? WHERE id = ?`, [title(), id]);
      else if (roll < 0.45) await harness.exec(`UPDATE songs SET album_id = ? WHERE id = ?`, [albumId(), id]);
      else if (roll < 0.6) await harness.exec(`DELETE FROM songs WHERE id = ?`, [id]);
      else if (roll < 0.8) await harness.insertSongs([song(next++, albumId(), { title: title() })]);
      else await window.utils.setWindow({ offset: Math.floor(random() * 40), limit: 25 });
      if (random() < 0.2) await sleep(Math.floor(random() * 10));
    }
    await ready;
    const { offset } = window.utils.getWindow?.() ?? { offset: 0 };
    await eventually(async () => {
      expect(window.toArray.map(stripVirtual).map(({ id }) => id)).toEqual(await selectIds(`SELECT id FROM songs WHERE album_id = 'a1' ORDER BY title, id LIMIT 25 OFFSET ?`, [offset]));
      expect(sortedIds(album2.toArray)).toEqual(await selectIds(`SELECT id FROM songs WHERE album_id = 'a2' ORDER BY id`));
      // The rows held are those of the database.
      for (const row of collection.toArray) {
        expect(stripVirtual(row)).toEqual(
          (await harness.run(harness.sql.unsafe<SongRow>(`SELECT id, album_id AS albumId, title, rating, updated_at AS updatedAt FROM songs WHERE id = ?`, [row.id])))[0],
        );
      }
    });
  });
});
