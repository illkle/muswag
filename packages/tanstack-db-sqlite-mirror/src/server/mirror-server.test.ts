import { blob, customType, numeric, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Cause, Effect, Exit, Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import type { MirrorChange, MirrorChangeBatch, MirrorMutation, MirrorResponse, MirrorResults } from "../protocol.js";
import { album, albums, createHarness, song, type Harness } from "../test/harness.js";
import { MirrorSchemaError, MirrorServer } from "./index.js";

let harness: Harness;

afterEach(async () => {
  await harness?.dispose();
});

const record = (h: Harness) => {
  const batches: Array<MirrorChangeBatch> = [];
  h.server.subscribe((batch) => batches.push(batch));
  return {
    batches,
    changes: () => batches.flatMap((batch) => batch.changes),
  };
};

const withoutSeq = (changes: ReadonlyArray<MirrorChange>) => changes.map(({ seq: _seq, ...change }) => change);

const request = (h: Harness, payload: Record<string, unknown>) => h.run(h.server.handle({ v: 1, ...payload }));

/** Batch of a successful pull that returned changes. */
const pulledBatch = (response: MirrorResponse) => {
  const result = response.ok ? (response.result as MirrorResults["pull"]) : undefined;
  if (result?.kind !== "changes") throw new Error(`expected pulled changes, got ${JSON.stringify(response)}`);
  return result.batch;
};

const mutate = (h: Harness, mutations: ReadonlyArray<MirrorMutation>) => request(h, { type: "mutate", mutations });

const expectError = (response: MirrorResponse, name: string, message?: RegExp) => {
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.name).toBe(name);
  if (message) expect(response.error.message).toMatch(message);
};

describe("change capture", () => {
  it("captures inserts, updates and deletes with decoded column values", async () => {
    harness = await createHarness();
    const log = record(harness);
    const created = new Date("2024-01-02T03:04:05.000Z");

    await harness.insertAlbums([album("a1", { starred: true, created, extra: { tags: ["x"] }, plays: 2 })]);
    await harness.exec(`UPDATE albums SET name = 'Renamed', starred = 0 WHERE id = 'a1'`);
    await harness.exec(`DELETE FROM albums WHERE id = 'a1'`);

    expect(withoutSeq(log.changes())).toEqual([
      { table: "albums", type: "upsert", key: "a1", value: album("a1", { starred: true, created, extra: { tags: ["x"] }, plays: 2 }) },
      { table: "albums", type: "upsert", key: "a1", value: album("a1", { name: "Renamed", starred: false, created, extra: { tags: ["x"] }, plays: 2 }) },
      { table: "albums", type: "delete", key: "a1" },
    ]);
  });

  it("broadcasts one contiguous batch per committed write", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.insertAlbums([album("a1"), album("a2")]);
    await harness.insertAlbums([album("a3")]);

    expect(log.batches).toHaveLength(2);
    const [first, second] = log.batches;
    expect(first!.changes.map((change) => change.seq)).toEqual([first!.fromSeq + 1, first!.fromSeq + 2]);
    expect(first!.toSeq).toBe(first!.fromSeq + 2);
    expect(second!.fromSeq).toBe(first!.toSeq);
    expect(second!.toSeq).toBe(second!.fromSeq + 1);
    expect(new Set(log.batches.map((batch) => batch.epoch))).toEqual(new Set([harness.server.epoch]));
  });

  it("keeps integer and text primary keys as stored", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.insertAlbums([album("10")]);
    await harness.insertSongs([song(7, "10")]);

    expect(log.changes().map((change) => change.key)).toEqual(["10", 7]);
  });

  it("captures every row touched by a bulk update", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1"), album("a2"), album("a3")]);
    const log = record(harness);

    await harness.exec(`UPDATE albums SET plays = plays + 1 WHERE id <> 'a2'`);

    expect(log.changes().map((change) => [change.key, change.type === "upsert" ? change.value.plays : null])).toEqual([
      ["a1", 1],
      ["a3", 1],
    ]);
  });

  it("captures foreign-key cascades", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1"), album("a2")]);
    await harness.insertSongs([song(1, "a1"), song(2, "a1"), song(3, "a2")]);
    const log = record(harness);

    await harness.exec(`DELETE FROM albums WHERE id = 'a1'`);

    expect(withoutSeq(log.changes())).toEqual([
      { table: "songs", type: "delete", key: 1 },
      { table: "songs", type: "delete", key: 2 },
      { table: "albums", type: "delete", key: "a1" },
    ]);
  });

  it("captures rows removed by REPLACE conflict resolution", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1", { slug: "same" })]);
    const log = record(harness);

    await harness.exec(`INSERT OR REPLACE INTO albums (id, name, slug) VALUES ('a2', 'Other', 'same')`);

    expect(withoutSeq(log.changes())).toEqual([
      { table: "albums", type: "delete", key: "a1" },
      { table: "albums", type: "upsert", key: "a2", value: album("a2", { name: "Other", slug: "same" }) },
    ]);
  });

  it("captures upserts", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const log = record(harness);

    await harness.exec(`INSERT INTO albums (id, name) VALUES ('a1', 'Upserted') ON CONFLICT(id) DO UPDATE SET name = excluded.name`);

    expect(withoutSeq(log.changes())).toEqual([{ table: "albums", type: "upsert", key: "a1", value: album("a1", { name: "Upserted" }) }]);
  });

  it("turns a primary-key change into a delete and an upsert", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const log = record(harness);

    await harness.exec(`UPDATE albums SET id = 'b1' WHERE id = 'a1'`);

    expect(withoutSeq(log.changes())).toEqual([
      { table: "albums", type: "delete", key: "a1" },
      { table: "albums", type: "upsert", key: "b1", value: album("b1", { name: "Album a1" }) },
    ]);
  });

  it("captures values written by JSON functions as stored", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1", { extra: { tags: ["x"] } })]);
    const log = record(harness);

    await harness.exec(`UPDATE albums SET extra = json_set(extra, '$.tags[1]', 'y'), name = json_quote('quoted') WHERE id = 'a1'`);
    await harness.insertAlbums([album("a2")]);

    expect(withoutSeq(log.changes())).toEqual([
      { table: "albums", type: "upsert", key: "a1", value: album("a1", { name: '"quoted"', extra: { tags: ["x", "y"] } }) },
      { table: "albums", type: "upsert", key: "a2", value: album("a2") },
    ]);
    expect(await harness.dbRows("albums")).toEqual([album("a1", { name: '"quoted"', extra: { tags: ["x", "y"] } }), album("a2")]);
  });

  it("skips a change it cannot decode without blocking later ones", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    await harness.insertSongs([song(99, "a1")]);
    const log = record(harness);
    const errors: Array<unknown> = [];
    const original = console.error;
    console.error = (...args: Array<unknown>) => errors.push(args);
    try {
      // A key beyond Number.MAX_SAFE_INTEGER cannot be read as a JS number. (node:sqlite refuses to
      // insert one into a rowid table outright, so it arrives through an update.)
      await harness.exec(`UPDATE songs SET id = 1152921504606846977 WHERE id = 99`);
      await harness.insertSongs([song(1, "a1")]);
    } finally {
      console.error = original;
    }

    expect(withoutSeq(log.changes()).map((change) => [change.type, change.key])).toEqual([
      ["delete", 99],
      ["upsert", 1],
    ]);
    expect(log.batches).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it("treats a case-only change of a NOCASE key as a new key", async () => {
    harness = await createHarness();
    await harness.run(harness.sql.unsafe(`CREATE TABLE genres (id TEXT PRIMARY KEY COLLATE NOCASE, label TEXT)`));
    const genres = sqliteTable("genres", { id: text().primaryKey(), label: text() });
    const scope = await harness.run(Scope.make());
    const server = await harness.run(MirrorServer.make({ tables: [genres], changeLogTable: "genre_changes" }).pipe(Scope.provide(scope)));
    const batches: Array<MirrorChangeBatch> = [];
    server.subscribe((batch) => batches.push(batch));

    await harness.run(server.write(harness.sql.unsafe(`INSERT INTO genres (id, label) VALUES ('rock', 'Rock')`)));
    await harness.run(server.write(harness.sql.unsafe(`UPDATE genres SET id = 'Rock' WHERE id = 'rock'`)));

    expect(withoutSeq(batches.flatMap((batch) => batch.changes)).slice(1)).toEqual([
      { table: "genres", type: "delete", key: "rock" },
      { table: "genres", type: "upsert", key: "Rock", value: { id: "Rock", label: "Rock" } },
    ]);
    await harness.run(Scope.close(scope, Exit.void));
  });

  it("reads real keys as the same numbers the rows carry", async () => {
    harness = await createHarness();
    await harness.run(harness.sql.unsafe(`CREATE TABLE points (id REAL PRIMARY KEY, label TEXT)`));
    const points = sqliteTable("points", { id: real().primaryKey(), label: text() });
    const scope = await harness.run(Scope.make());
    const server = await harness.run(MirrorServer.make({ tables: [points], changeLogTable: "point_changes" }).pipe(Scope.provide(scope)));
    const batches: Array<MirrorChangeBatch> = [];
    server.subscribe((batch) => batches.push(batch));

    await harness.run(server.write(harness.sql.unsafe(`INSERT INTO points (id, label) VALUES (1.5, 'a'), (0.1 + 0.2, 'b')`)));
    await harness.run(server.write(harness.sql.unsafe(`DELETE FROM points`)));

    expect(withoutSeq(batches.flatMap((batch) => batch.changes))).toEqual([
      { table: "points", type: "upsert", key: 1.5, value: { id: 1.5, label: "a" } },
      { table: "points", type: "upsert", key: 0.1 + 0.2, value: { id: 0.1 + 0.2, label: "b" } },
      { table: "points", type: "delete", key: 1.5 },
      { table: "points", type: "delete", key: 0.1 + 0.2 },
    ]);
    await harness.run(Scope.close(scope, Exit.void));
  });

  it("encodes and decodes custom column types", async () => {
    harness = await createHarness();
    await harness.run(harness.sql.unsafe(`CREATE TABLE tagged (id TEXT PRIMARY KEY, tags TEXT NOT NULL)`));
    const tagList = customType<{ data: Array<string>; driverData: string }>({
      dataType: () => "text",
      toDriver: (value) => value.join(","),
      fromDriver: (value) => value.split(","),
    });
    const tagged = sqliteTable("tagged", { id: text().primaryKey(), tags: tagList().notNull() });
    const scope = await harness.run(Scope.make());
    const server = await harness.run(MirrorServer.make({ tables: [tagged], changeLogTable: "tagged_changes" }).pipe(Scope.provide(scope)));
    const batches: Array<MirrorChangeBatch> = [];
    server.subscribe((batch) => batches.push(batch));

    await harness.run(server.handle({ v: 1, type: "mutate", mutations: [{ table: "tagged", type: "insert", value: { id: "t1", tags: ["a", "b"] } }] }));

    expect(await harness.run(harness.sql.unsafe(`SELECT tags FROM tagged`))).toEqual([{ tags: "a,b" }]);
    expect(withoutSeq(batches.flatMap((batch) => batch.changes))).toEqual([{ table: "tagged", type: "upsert", key: "t1", value: { id: "t1", tags: ["a", "b"] } }]);
    await harness.run(Scope.close(scope, Exit.void));
  });

  it("reads plain numbers even when the caller enables safe integers", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.run(harness.server.write(harness.sql.unsafe(`INSERT INTO songs (id, album_id, title) SELECT 5, 'a1', 'S' WHERE 0`)).pipe(Effect.provideService(SqlClient.SafeIntegers, true)));
    await harness.run(harness.server.write(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`)).pipe(Effect.provideService(SqlClient.SafeIntegers, true)));

    expect(log.batches).toHaveLength(1);
    expect(typeof log.batches[0]!.toSeq).toBe("number");
  });

  it("ignores tables that are not mirrored", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.exec(`INSERT INTO unmirrored (id) VALUES ('x')`);

    expect(log.batches).toEqual([]);
  });
});

describe("write", () => {
  it("broadcasts nothing for a rolled-back write", async () => {
    harness = await createHarness();
    const log = record(harness);
    const before = await harness.run(harness.server.position);

    const exit = await harness.run(
      Effect.exit(
        harness.server.write(
          Effect.gen(function* () {
            yield* harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`);
            return yield* Effect.fail("boom");
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(log.batches).toEqual([]);
    expect(await harness.run(harness.server.position)).toEqual(before);
    expect(await harness.dbRows("albums")).toEqual([]);
  });

  it("returns the effect's value", async () => {
    harness = await createHarness();
    expect(await harness.write(Effect.succeed(42))).toBe(42);
  });

  it("joins an enclosing transaction and broadcasts after it commits", async () => {
    harness = await createHarness();
    const log = record(harness);
    let batchesInsideTransaction = -1;

    await harness.run(
      harness.sql.withTransaction(
        Effect.gen(function* () {
          yield* harness.server.write(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`));
          yield* Effect.sleep("10 millis");
          batchesInsideTransaction = log.batches.length;
          yield* harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a2', 'B')`);
        }),
      ),
    );

    expect(batchesInsideTransaction).toBe(0);
    await expect.poll(() => log.changes().map((change) => change.key)).toEqual(["a1", "a2"]);
  });

  it("broadcasts nothing when the enclosing transaction rolls back", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.run(
      Effect.exit(
        harness.sql.withTransaction(
          Effect.gen(function* () {
            yield* harness.server.write(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`));
            return yield* Effect.fail("boom");
          }),
        ),
      ),
    );
    await harness.run(harness.server.flush);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(log.batches).toEqual([]);
  });

  it("broadcasts writes made outside write on the next flush", async () => {
    harness = await createHarness();
    const log = record(harness);

    await harness.run(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`));
    expect(log.batches).toEqual([]);

    await harness.run(harness.server.flush);
    expect(log.changes().map((change) => change.key)).toEqual(["a1"]);
  });

  it("broadcasts writes made outside write on the auto-flush interval", async () => {
    harness = await createHarness({ server: { autoFlushInterval: "5 millis" } });
    const log = record(harness);

    await harness.run(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`));

    await expect.poll(() => log.changes().map((change) => change.key)).toEqual(["a1"]);
  });

  it("reports the position of a write's own changes", async () => {
    harness = await createHarness();
    const log = record(harness);

    const position = await harness.write(
      Effect.gen(function* () {
        yield* harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`);
        return yield* harness.server.position;
      }),
    );

    expect(position).toEqual({ epoch: harness.server.epoch, seq: log.batches[0]!.toSeq });
  });

  it("does not fail a committed write when broadcasting after it fails", async () => {
    harness = await createHarness({ server: { retainChanges: 1 } });
    // Make pruning, which runs after the broadcast, fail.
    await harness.run(harness.sql.unsafe(`CREATE TRIGGER block_prune BEFORE DELETE ON __mirror_changes BEGIN SELECT RAISE(ABORT, 'no pruning'); END`));
    const log = record(harness);

    for (let i = 0; i < 4; i++) await harness.insertAlbums([album(`a${i}`)]);

    expect(log.changes().map((change) => change.key)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(await harness.dbRows("albums")).toHaveLength(4);
  });

  it("keeps broadcasting when a listener throws", async () => {
    harness = await createHarness();
    harness.server.subscribe(() => {
      throw new Error("listener failed");
    });
    const log = record(harness);
    const errors: Array<unknown> = [];
    const original = console.error;
    console.error = (...args: Array<unknown>) => errors.push(args);
    try {
      await harness.insertAlbums([album("a1")]);
    } finally {
      console.error = original;
    }

    expect(log.batches).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

describe("requests", () => {
  it("answers hello with the last broadcast position", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    await harness.run(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a2', 'B')`));

    const response = await request(harness, { type: "hello" });
    const position = await harness.run(harness.server.position);

    expect(response).toEqual({ ok: true, result: { epoch: harness.server.epoch, seq: position.seq - 1 } });
  });

  it("snapshots a table with its current position", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1", { starred: true }), album("a2")]);

    const response = await request(harness, { type: "snapshot", table: "albums" });

    expect(response).toEqual({
      ok: true,
      result: { epoch: harness.server.epoch, seq: (await harness.run(harness.server.position)).seq, rows: [album("a1", { starred: true }), album("a2")] },
    });
  });

  it("rejects snapshots of tables it does not mirror", async () => {
    harness = await createHarness();
    expectError(await request(harness, { type: "snapshot", table: "unmirrored" }), "MirrorRequestError", /not mirrored/);
  });

  it("pulls changes after a position", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const { seq } = await harness.run(harness.server.position);
    await harness.insertAlbums([album("a2")]);
    await harness.exec(`DELETE FROM albums WHERE id = 'a1'`);

    const response = await request(harness, { type: "pull", fromSeq: seq });

    const batch = pulledBatch(response);
    expect(batch.fromSeq).toBe(seq);
    expect(batch.toSeq).toBe(seq + 2);
    expect(withoutSeq(batch.changes)).toEqual([
      { table: "albums", type: "upsert", key: "a2", value: album("a2") },
      { table: "albums", type: "delete", key: "a1" },
    ]);
  });

  it("returns an empty batch when pulling from the current position", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const { seq } = await harness.run(harness.server.position);

    const response = await request(harness, { type: "pull", fromSeq: seq });

    expect(response).toEqual({ ok: true, result: { epoch: harness.server.epoch, kind: "changes", batch: { epoch: harness.server.epoch, fromSeq: seq, toSeq: seq, changes: [] } } });
  });

  it("prunes old changes and asks clients that fall behind to reset", async () => {
    harness = await createHarness({ server: { retainChanges: 2 } });
    const start = await harness.run(harness.server.position);
    for (let i = 0; i < 6; i++) await harness.insertAlbums([album(`a${i}`)]);

    expect(await request(harness, { type: "pull", fromSeq: start.seq })).toEqual({ ok: true, result: { epoch: harness.server.epoch, kind: "reset" } });

    const latest = await harness.run(harness.server.position);
    const recent = await request(harness, { type: "pull", fromSeq: latest.seq - 2 });
    expect(pulledBatch(recent).changes.map((change) => change.key)).toEqual(["a4", "a5"]);
  });

  it.each([
    ["a non-object", "nope", /expected an object/],
    ["an unknown version", { v: 2, type: "hello" }, /protocol version/],
    ["an unknown type", { v: 1, type: "explode" }, /unknown request type/],
    ["a snapshot without a table", { v: 1, type: "snapshot" }, /table must be a string/],
    ["a pull without a position", { v: 1, type: "pull" }, /fromSeq/],
    ["a mutation list that is not an array", { v: 1, type: "mutate", mutations: {} }, /must be an array/],
    ["an insert without a value", { v: 1, type: "mutate", mutations: [{ table: "albums", type: "insert" }] }, /malformed/],
    ["an update without changes", { v: 1, type: "mutate", mutations: [{ table: "albums", type: "update", key: "a" }] }, /malformed/],
    ["a delete without a key", { v: 1, type: "mutate", mutations: [{ table: "albums", type: "delete" }] }, /malformed/],
  ])("rejects %s", async (_name, payload, message) => {
    harness = await createHarness();
    expectError(await harness.run(harness.server.handle(payload)), "MirrorRequestError", message);
  });
});

describe("mutate", () => {
  it("applies mutations, runtime defaults and $onUpdate functions", async () => {
    harness = await createHarness();
    const log = record(harness);

    const inserted = await mutate(harness, [
      { table: "albums", type: "insert", value: { id: "a1", name: "A", starred: true, created: new Date("2024-01-01T00:00:00Z"), extra: { tags: ["t"] } } },
      { table: "songs", type: "insert", value: { id: 1, albumId: "a1", title: "S" } },
    ]);
    expect(inserted).toEqual({ ok: true, result: { epoch: harness.server.epoch, seq: log.batches.at(-1)!.toSeq } });

    const [insertedSong] = await harness.dbRows("songs");
    expect(insertedSong).toMatchObject({ id: 1, rating: 3 });
    expect(typeof insertedSong!.updatedAt).toBe("number");

    await mutate(harness, [{ table: "songs", type: "update", key: 1, changes: { title: "S2" } }]);
    const [updatedSong] = await harness.dbRows("songs");
    expect(updatedSong).toMatchObject({ title: "S2", rating: 3 });
    expect(updatedSong!.updatedAt as number).toBeGreaterThan(insertedSong!.updatedAt as number);

    expect(await harness.dbRows("albums")).toEqual([album("a1", { name: "A", starred: true, created: new Date("2024-01-01T00:00:00Z"), extra: { tags: ["t"] } })]);

    await mutate(harness, [{ table: "albums", type: "delete", key: "a1" }]);
    expect(await harness.dbRows("albums")).toEqual([]);
    expect(await harness.dbRows("songs")).toEqual([]);
  });

  it("ignores TanStack DB virtual properties", async () => {
    harness = await createHarness();
    expect((await mutate(harness, [{ table: "albums", type: "insert", value: { id: "a1", name: "A", $synced: false, $origin: "local" } }])).ok).toBe(true);
    expect((await mutate(harness, [{ table: "albums", type: "update", key: "a1", changes: { name: "B", $synced: false } }])).ok).toBe(true);
    expect(await harness.dbRows("albums")).toEqual([album("a1", { name: "B" })]);
  });

  it("applies a batch atomically", async () => {
    harness = await createHarness();
    const log = record(harness);

    const response = await mutate(harness, [
      { table: "albums", type: "insert", value: { id: "a1", name: "A" } },
      { table: "albums", type: "update", key: "missing", changes: { name: "B" } },
    ]);

    expectError(response, "MirrorRequestError", /does not exist/);
    expect(await harness.dbRows("albums")).toEqual([]);
    expect(log.batches).toEqual([]);
  });

  it("surfaces constraint violations", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);

    const response = await mutate(harness, [{ table: "albums", type: "insert", value: { id: "a1", name: "Again" } }]);

    expectError(response, "SqlError");
  });

  it("rejects unknown columns and tables", async () => {
    harness = await createHarness();
    expectError(await mutate(harness, [{ table: "albums", type: "insert", value: { id: "a1", name: "A", nope: 1 } }]), "MirrorRequestError", /Unknown column "nope"/);
    expectError(await mutate(harness, [{ table: "unmirrored", type: "insert", value: { id: "x" } }]), "MirrorRequestError", /not mirrored/);
  });

  it("treats deleting a missing row as done", async () => {
    harness = await createHarness();
    expect((await mutate(harness, [{ table: "albums", type: "delete", key: "missing" }])).ok).toBe(true);
  });

  it("skips updates without changes", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const log = record(harness);

    expect((await mutate(harness, [{ table: "albums", type: "update", key: "a1", changes: {} }])).ok).toBe(true);
    expect(log.batches).toEqual([]);
  });
});

describe("startup", () => {
  it("rebuilds triggers and starts a new stream on restart", async () => {
    harness = await createHarness();
    await harness.insertAlbums([album("a1")]);
    const first = harness.server;
    const before = await harness.run(first.position);

    const second = await harness.startServer();
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect((await harness.run(second.position)).seq).toBe(before.seq);

    const log = record(harness);
    await harness.insertAlbums([album("a2")]);
    expect(log.changes().map((change) => [change.key, change.seq])).toEqual([["a2", before.seq + 1]]);

    const triggers = await harness.run(harness.sql.unsafe<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`));
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      "__mirror_changes__albums_delete",
      "__mirror_changes__albums_insert",
      "__mirror_changes__albums_update",
      "__mirror_changes__songs_delete",
      "__mirror_changes__songs_insert",
      "__mirror_changes__songs_update",
    ]);
  });

  it("drops triggers of tables that are no longer mirrored and picks up new columns", async () => {
    harness = await createHarness();
    await harness.run(
      Effect.gen(function* () {
        yield* harness.sql.unsafe(`ALTER TABLE unmirrored ADD COLUMN label TEXT`);
      }),
    );
    const widened = sqliteTable("unmirrored", { id: text().primaryKey(), label: text() });

    const scope = await harness.run(Scope.make());
    const server = await harness.run(MirrorServer.make({ tables: [widened] }).pipe(Scope.provide(scope)));
    const batches: Array<MirrorChangeBatch> = [];
    server.subscribe((batch) => batches.push(batch));

    await harness.run(server.write(harness.sql.unsafe(`INSERT INTO unmirrored (id, label) VALUES ('x', 'hello')`)));
    await harness.run(server.write(harness.sql.unsafe(`INSERT INTO albums (id, name) VALUES ('a1', 'A')`)));

    expect(withoutSeq(batches.flatMap((batch) => batch.changes))).toEqual([{ table: "unmirrored", type: "upsert", key: "x", value: { id: "x", label: "hello" } }]);
    await harness.run(Scope.close(scope, Exit.void));
  });

  it("fails when a mirrored table does not exist", async () => {
    harness = await createHarness();
    const missing = sqliteTable("missing", { id: text().primaryKey() });
    const exit = await harness.run(Effect.exit(Effect.scoped(MirrorServer.make({ tables: [missing] }))));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it.each([
    ["composite primary keys", sqliteTable("t", { a: text(), b: text() }, (t) => [primaryKey({ columns: [t.a, t.b] })]), /composite primary key/],
    ["tables without a primary key", sqliteTable("t", { a: text() }), /exactly one primary-key column/],
    ["blob columns", sqliteTable("t", { id: text().primaryKey(), data: blob() }), /blob and bigint columns cannot be mirrored/],
    ["bigint numeric columns", sqliteTable("t", { id: text().primaryKey(), n: numeric({ mode: "bigint" }) }), /unsupported type SQLiteNumericBigInt/],
    ["the same table twice", albums, /registered twice/],
  ])("rejects %s", async (_name, table, message) => {
    harness = await createHarness();
    const tables = table === albums ? [albums, albums] : [table];
    const exit = await harness.run(Effect.exit(Effect.scoped(MirrorServer.make({ tables }))));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toBeInstanceOf(MirrorSchemaError);
    expect((error as Error).message).toMatch(message);
  });
});
