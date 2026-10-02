import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { MirrorChangeBatch, MirrorResponse, MirrorResults } from "../../protocol.js";
import { counters, player, players } from "../../test/memory-harness.js";
import { memoryTable } from "../../memory/index.js";
import { Player } from "../../test/memory-harness.js";
import { MemoryMirror, MirrorSchemaError, type MemoryMirrorOptions, type MemoryMirrorService } from "./index.js";

let scope: Scope.Closeable | null = null;
afterEach(async () => {
  if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
  scope = null;
});

async function start(options: Partial<MemoryMirrorOptions> = {}) {
  scope = await Effect.runPromise(Scope.make());
  const server = await Effect.runPromise(MemoryMirror.make({ tables: [players, counters], ...options }).pipe(Scope.provide(scope)));
  const batches: Array<MirrorChangeBatch> = [];
  server.subscribe((batch) => batches.push(batch));
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const request = async <T extends keyof MirrorResults>(body: Record<string, unknown>) => {
    const response = (await run(server.handle({ v: 1, ...body }))) as MirrorResponse<T>;
    if (!response.ok) throw new Error(`${response.error.name}: ${response.error.message}`);
    return response.result as MirrorResults[T];
  };
  return { server, batches, run, request };
}

const failed = async (server: MemoryMirrorService, body: Record<string, unknown>) => {
  const response = await Effect.runPromise(server.handle({ v: 1, ...body }));
  if (response.ok) throw new Error("expected the request to fail");
  return response.error;
};

describe("writes", () => {
  it("broadcasts upserts and deletes with encoded values", async () => {
    const { server, batches, run } = await start();
    const joined = new Date(1_700_000_000_000);
    await run(server.upsert(players, player("p1", { joined })));
    await run(server.delete(players, "p1"));
    expect(batches).toEqual([
      { epoch: server.epoch, fromSeq: 0, toSeq: 1, changes: [{ seq: 1, table: "players", type: "upsert", key: "p1", value: { ...player("p1"), joined: 1_700_000_000_000 } }] },
      { epoch: server.epoch, fromSeq: 1, toSeq: 2, changes: [{ seq: 2, table: "players", type: "delete", key: "p1" }] },
    ]);
  });

  it("broadcasts one batch per write, across tables", async () => {
    const { server, batches, run } = await start();
    await run(
      server.write(
        Effect.gen(function* () {
          yield* server.upsert(players, player("p1"));
          yield* server.upsert(counters, { id: 1, count: 1 });
          yield* server.upsert(players, player("p2"));
        }),
      ),
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.changes.map((change) => [change.table, change.key])).toEqual([
      ["players", "p1"],
      ["players", "p2"],
      ["counters", 1],
    ]);
  });

  it("broadcasts nothing and keeps nothing when a write fails", async () => {
    const { server, batches, run } = await start();
    const exit = await Effect.runPromiseExit(server.write(Effect.andThen(server.upsert(players, player("p1")), Effect.fail("boom"))));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(batches).toEqual([]);
    expect(await run(server.rows(players))).toEqual([]);
  });

  it("lets reads inside a write see its own changes, and nobody else", async () => {
    const { server, run } = await start();
    await run(server.upsert(players, player("p1")));
    const seen = await run(
      server.write(
        Effect.gen(function* () {
          yield* server.delete(players, "p1");
          yield* server.upsert(players, player("p2"));
          const inside = { p1: yield* server.get(players, "p1"), rows: yield* server.rows(players) };
          const outside = yield* Effect.promise(() => Effect.runPromise(server.rows(players)));
          return { inside, outside };
        }),
      ),
    );
    expect(seen.inside).toEqual({ p1: undefined, rows: [player("p2")] });
    expect(seen.outside).toEqual([player("p1")]);
  });

  it("joins an enclosing write", async () => {
    const { server, batches, run } = await start();
    await run(server.write(server.write(Effect.andThen(server.upsert(players, player("p1")), server.write(server.upsert(players, player("p2")))))));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.changes).toHaveLength(2);
  });

  it("broadcasts only the end state of each row a write touched", async () => {
    const { server, batches, run } = await start();
    await run(server.upsert(players, player("kept")));
    await run(
      server.write(
        Effect.gen(function* () {
          yield* server.upsert(players, player("p1", { volume: 10 }));
          yield* server.upsert(players, player("p1", { volume: 20 }));
          yield* server.upsert(players, player("gone"));
          yield* server.delete(players, "gone");
        }),
      ),
    );
    expect(batches[1]!.changes).toEqual([{ seq: 2, table: "players", type: "upsert", key: "p1", value: player("p1", { volume: 20 }) }]);
  });

  it("does not broadcast rewriting a row with an equal value", async () => {
    const { server, batches, run } = await start();
    await run(server.upsert(players, player("p1", { joined: new Date(5), tags: ["a"] })));
    await run(server.upsert(players, player("p1", { joined: new Date(5), tags: ["a"] })));
    await run(server.delete(players, "missing"));
    expect(batches).toHaveLength(1);
  });

  it("replaces a table's contents", async () => {
    const { server, batches, run } = await start();
    await run(server.replace(players, [player("p1"), player("p2")]));
    await run(server.replace(players, [player("p2"), player("p3")]));
    expect(await run(server.rows(players))).toEqual([player("p2"), player("p3")]);
    expect(batches[1]!.changes.map((change) => [change.type, change.key])).toEqual([
      ["upsert", "p3"],
      ["delete", "p1"],
    ]);
  });

  it("dies on rows that do not satisfy the schema and on tables it does not serve", async () => {
    const { server, batches } = await start();
    const invalid = await Effect.runPromiseExit(server.upsert(players, player("p1", { volume: 101 })));
    expect(Exit.isFailure(invalid) && invalid.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true);
    const other = memoryTable("players", Player, { primaryKey: "id" });
    expect(Exit.isFailure(await Effect.runPromiseExit(server.upsert(other, player("p1"))))).toBe(true);
    expect(batches).toEqual([]);
  });

  it("reports the position after a write", async () => {
    const { server, run } = await start();
    await run(server.upsert(players, player("p1")));
    expect(await run(server.position)).toEqual({ epoch: server.epoch, seq: 1 });
  });

  it("refuses a table registered twice", async () => {
    scope = await Effect.runPromise(Scope.make());
    const exit = await Effect.runPromiseExit(MemoryMirror.make({ tables: [players, players] }).pipe(Scope.provide(scope)));
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error instanceof MirrorSchemaError)).toBe(true);
  });

  it("starts each server on a newer epoch", async () => {
    const first = await start();
    const second = await start();
    expect(second.server.epoch).toBeGreaterThan(first.server.epoch);
  });
});

describe("requests", () => {
  it("answers hello and snapshots with encoded rows at the current position", async () => {
    const { server, run, request } = await start();
    await run(server.upsert(players, player("p1", { joined: new Date(7) })));
    expect(await request<"hello">({ type: "hello" })).toEqual({ epoch: server.epoch, seq: 1 });
    expect(await request<"snapshot">({ type: "snapshot", table: "players" })).toEqual({ epoch: server.epoch, seq: 1, rows: [{ ...player("p1"), joined: 7 }] });
    expect((await failed(server, { type: "snapshot", table: "nope" })).message).toContain("not mirrored");
  });

  it("pulls changes after a position, and asks clients that fell behind pruning to reset", async () => {
    const { server, run, request } = await start({ retainChanges: 2 });
    for (let i = 1; i <= 3; i++) await run(server.upsert(counters, { id: i, count: i }));
    const pulled = await request<"pull">({ type: "pull", fromSeq: 1 });
    expect(pulled).toMatchObject({ kind: "changes", batch: { fromSeq: 1, toSeq: 3 } });
    expect(await request<"pull">({ type: "pull", fromSeq: 3 })).toMatchObject({ kind: "changes", batch: { fromSeq: 3, toSeq: 3, changes: [] } });
    for (let i = 4; i <= 6; i++) await run(server.upsert(counters, { id: i, count: i }));
    expect(await request<"pull">({ type: "pull", fromSeq: 1 })).toEqual({ epoch: server.epoch, kind: "reset" });
    expect(await request<"pull">({ type: "pull", fromSeq: 4 })).toMatchObject({ kind: "changes", batch: { fromSeq: 4, toSeq: 6 } });
  });

  it("applies mutations atomically from encoded values", async () => {
    const { server, batches, run, request } = await start();
    await request<"mutate">({
      type: "mutate",
      mutations: [
        { table: "players", type: "insert", value: { ...player("p1"), joined: 9 } },
        { table: "players", type: "update", key: "p1", changes: { volume: 70 } },
        { table: "counters", type: "insert", value: { id: 1, count: 0 } },
      ],
    });
    expect(await run(server.get(players, "p1"))).toEqual(player("p1", { joined: new Date(9), volume: 70 }));
    expect(batches).toHaveLength(1);

    const rejected = [
      [{ table: "players", type: "insert", value: player("p1") }, "already exists"],
      [{ table: "players", type: "update", key: "zz", changes: { volume: 1 } }, "does not exist"],
      [{ table: "players", type: "update", key: "p1", changes: { volume: 500 } }, "Invalid row"],
      [{ table: "players", type: "update", key: "p1", changes: { id: "p9" } }, "cannot change the key"],
      [{ table: "nope", type: "delete", key: 1 }, "not mirrored"],
    ] as const;
    for (const [mutation, message] of rejected) {
      const error = await failed(server, { type: "mutate", mutations: [{ table: "counters", type: "delete", key: 1 }, mutation] });
      expect(error.message).toContain(message);
    }
    // Every rejected request also tried to delete the counter, and none of them did.
    expect(await run(server.rows(counters))).toEqual([{ id: 1, count: 0 }]);
    expect(batches).toHaveLength(1);
  });

  it("rejects mutations when read-only", async () => {
    const { server } = await start({ readOnly: true });
    expect((await failed(server, { type: "mutate", mutations: [{ table: "counters", type: "delete", key: 1 }] })).message).toContain("read-only");
  });

  it("rejects malformed requests", async () => {
    const { server } = await start();
    expect((await failed(server, { type: "explode" })).name).toBe("MirrorRequestError");
  });
});
