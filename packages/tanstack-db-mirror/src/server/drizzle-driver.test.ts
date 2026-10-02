import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { eq } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { albums, createHarness, eventually, expectInSync, stripVirtual, type Harness } from "../test/harness.js";

let harness: Harness;

afterEach(async () => {
  await harness?.dispose();
});

/** A Drizzle database on the harness's connection, as an app's main process would create it. */
const drizzleOf = (h: Harness) => h.run(makeWithDefaults().pipe(Effect.provideService(SqliteClient.SqliteClient, h.sql as SqliteClient.SqliteClient)));

describe("drizzle effect driver", () => {
  it("mirrors writes made through Drizzle with the same value encoding", async () => {
    harness = await createHarness();
    const db = await drizzleOf(harness);
    const client = harness.connect();
    await client.albums.preload();

    await harness.write(db.insert(albums).values({ id: "a1", name: "A", starred: true, created: new Date(1_000), extra: { tags: ["x"] }, slug: "a" }));
    await harness.write(db.update(albums).set({ name: "B" }).where(eq(albums.id, "a1")));

    await eventually(() => expect(client.albums.get("a1")?.name).toBe("B"));
    expect(client.albums.get("a1")).toMatchObject({ starred: true, created: new Date(1_000), extra: { tags: ["x"] } });
    expect(await harness.run(db.select().from(albums))).toEqual([stripVirtual(client.albums.get("a1")!)]);
    await expectInSync(harness, client);
  });

  it("commits a Drizzle transaction inside mirror.write atomically", async () => {
    harness = await createHarness();
    const db = await drizzleOf(harness);
    const client = harness.connect();
    await client.albums.preload();
    const batches: Array<unknown> = [];
    harness.server.subscribe((batch) => batches.push(batch));

    await harness.write(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(albums).values({ id: "a1", name: "A", slug: "a" });
          yield* tx.insert(albums).values({ id: "a2", name: "B", slug: "b" });
        }),
      ),
    );

    expect(batches).toHaveLength(1);
    await eventually(() => expect(client.albums.size).toBe(2));
    await expectInSync(harness, client);
  });

  it("broadcasts mirror.write inside a Drizzle transaction only once it commits", async () => {
    harness = await createHarness();
    const db = await drizzleOf(harness);
    const client = harness.connect();
    await client.albums.preload();
    const batches: Array<unknown> = [];
    harness.server.subscribe((batch) => batches.push(batch));

    const rolledBack = await harness.run(
      Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* harness.server.write(tx.insert(albums).values({ id: "x", name: "X", slug: "x" }));
            return yield* Effect.fail("rollback");
          }),
        ),
      ),
    );
    expect(Exit.isFailure(rolledBack)).toBe(true);

    await harness.run(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* harness.server.write(tx.insert(albums).values({ id: "a1", name: "A", slug: "a" }));
          expect(batches).toEqual([]);
          yield* tx.insert(albums).values({ id: "a2", name: "B", slug: "b" });
        }),
      ),
    );

    await eventually(() => expect(client.albums.size).toBe(2));
    expect(client.albums.has("x")).toBe(false);
    await expectInSync(harness, client);
  });
});
