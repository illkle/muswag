import { Context, Effect, Layer, Scope } from "effect";

import { MirrorSchemaError } from "../../errors.js";
import type { MirrorChange, MirrorChangeBatch, MirrorKey, MirrorMutation, MirrorPosition, MirrorRequest, MirrorResponse, MirrorResults, MirrorRow, MirrorServerTransport } from "../../protocol.js";
import type { AnyMemoryTable, MemoryTable } from "../../table.js";
import { handleRequest, makeListeners, MirrorRequestError, readOnlyError, serveWith } from "../shared.js";

export interface MemoryMirrorOptions {
  readonly tables: ReadonlyArray<AnyMemoryTable>;
  /** How many already-broadcast changes to keep for clients recovering from a gap. Defaults to 10 000. */
  readonly retainChanges?: number | undefined;
  /**
   * Rejects `mutate` requests, so clients can only read and every change goes through this server.
   * Pair it with `readOnly` collections on the client.
   */
  readonly readOnly?: boolean | undefined;
}

export interface MemoryMirrorService {
  /** Increases every time a server starts; clients reload when it changes. */
  readonly epoch: number;
  /**
   * Runs `effect` as one write. Its changes become visible, and are broadcast as one batch, only once
   * it succeeds; if it fails they are discarded. A write inside another joins it. Writes do not isolate
   * from each other: when two change the same row, the one that finishes last wins.
   */
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Inserts or replaces the row with `row`'s key. Dies if `row` does not satisfy the table's schema. */
  readonly upsert: <Row extends object>(table: MemoryTable<Row, any>, row: NoInfer<Row>) => Effect.Effect<void>;
  readonly delete: <Key extends MirrorKey>(table: MemoryTable<any, Key>, key: NoInfer<Key>) => Effect.Effect<void>;
  /** Makes `rows` the table's entire contents. */
  readonly replace: <Row extends object>(table: MemoryTable<Row, any>, rows: Iterable<NoInfer<Row>>) => Effect.Effect<void>;
  /** Reads include the changes of the enclosing write. */
  readonly get: <Row extends object, Key extends MirrorKey>(table: MemoryTable<Row, Key>, key: NoInfer<Key>) => Effect.Effect<Row | undefined>;
  readonly rows: <Row extends object>(table: MemoryTable<Row, any>) => Effect.Effect<ReadonlyArray<Row>>;
  /**
   * Latest change position. Changes get their position when their write commits, so read it after the
   * write; a command can return it and the renderer can wait for it with `collection.utils.awaitPosition`.
   */
  readonly position: Effect.Effect<MirrorPosition>;
  /** Handles one protocol request. Never fails; errors are returned in the response envelope. */
  readonly handle: (request: unknown) => Effect.Effect<MirrorResponse>;
  readonly subscribe: (listener: (batch: MirrorChangeBatch) => void) => () => void;
  /** Connects a transport for the lifetime of the current scope. */
  readonly serve: (transport: MirrorServerTransport) => Effect.Effect<void, never, Scope.Scope>;
}

type Stored = { readonly row: object; readonly encoded: MirrorRow };
/** A write's changes by table and key; `null` marks a deletion. */
type Staged = Map<string, Map<MirrorKey, Stored | null>>;

/** The open write of each server in the current fiber, keyed by server id. */
const CurrentWrites = Context.Reference<ReadonlyMap<number, Staged>>("@muswag/tanstack-db-mirror/MemoryMirror/CurrentWrites", { defaultValue: () => new Map() });

const DEFAULT_RETAIN_CHANGES = 10_000;
let lastServerId = 0;
let lastEpoch = 0;

export const make = Effect.fnUntraced(function* (options: MemoryMirrorOptions) {
  const id = ++lastServerId;
  // Seeded from the clock so a server in a restarted process still moves the epoch forward.
  const epoch = (lastEpoch = Math.max(Date.now(), lastEpoch + 1));
  const retainChanges = options.retainChanges ?? DEFAULT_RETAIN_CHANGES;

  const tables = new Map<string, AnyMemoryTable>();
  const data = new Map<string, Map<MirrorKey, Stored>>();
  for (const table of options.tables) {
    if (tables.has(table.name)) return yield* Effect.fail(new MirrorSchemaError(`Table "${table.name}" is registered twice`));
    tables.set(table.name, table);
    data.set(table.name, new Map());
  }

  let seq = 0;
  let prunedThroughSeq = 0;
  const log: Array<MirrorChange> = [];
  const { subscribe, broadcast } = makeListeners();

  const owned = (table: AnyMemoryTable) => {
    if (tables.get(table.name) !== table) throw new Error(`Table "${table.name}" is not mirrored by this server`);
    return table;
  };
  const requireTable = (name: string) => {
    const table = tables.get(name);
    if (!table) throw new MirrorRequestError({ message: `Table "${name}" is not mirrored` });
    return table;
  };

  /** The row as the write that `stage` belongs to sees it. */
  const read = (stage: Staged | undefined, table: string, key: MirrorKey): Stored | undefined => {
    const staged = stage?.get(table);
    if (staged?.has(key)) return staged.get(key) ?? undefined;
    return data.get(table)!.get(key);
  };
  const stageChange = (stage: Staged, table: string, key: MirrorKey, next: Stored | null) => {
    let staged = stage.get(table);
    if (!staged) stage.set(table, (staged = new Map()));
    staged.set(key, next);
  };
  const store = (table: AnyMemoryTable, row: object): Stored => ({ row, encoded: table.encode(row) });

  const commit = (stage: Staged) => {
    const fromSeq = seq;
    const changes: Array<MirrorChange> = [];
    for (const [name, staged] of stage) {
      const rows = data.get(name)!;
      for (const [key, next] of staged) {
        const previous = rows.get(key);
        if (next === null) {
          if (!previous) continue;
          rows.delete(key);
          changes.push({ seq: ++seq, table: name, type: "delete", key });
        } else {
          rows.set(key, next);
          // Rewriting a row with the same value is not a change.
          if (!previous || !sameValue(previous.encoded, next.encoded)) changes.push({ seq: ++seq, table: name, type: "upsert", key, value: next.encoded });
        }
      }
    }
    if (changes.length === 0) return;
    log.push(...changes);
    if (log.length > retainChanges * 2) {
      const removed = log.splice(0, log.length - retainChanges);
      prunedThroughSeq = removed.at(-1)!.seq;
    }
    broadcast({ epoch, fromSeq, toSeq: seq, changes });
  };

  const write = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const writes = yield* CurrentWrites;
      if (writes.has(id)) return yield* effect;
      const stage: Staged = new Map();
      const result = yield* Effect.provideService(effect, CurrentWrites, new Map([...writes, [id, stage]]));
      commit(stage);
      return result;
    });

  /** Runs `change` against the current write, or as a write of its own. */
  const change = (apply: (stage: Staged) => void) => write(Effect.flatMap(Effect.service(CurrentWrites), (writes) => Effect.sync(() => apply(writes.get(id)!))));
  const view = Effect.map(Effect.service(CurrentWrites), (writes) => writes.get(id));

  const upsert = <Row extends object>(table: MemoryTable<Row, any>, row: Row) =>
    change((stage) => {
      owned(table);
      stageChange(stage, table.name, table.keyOf(row), store(table, row));
    });
  const remove = <Key extends MirrorKey>(table: MemoryTable<any, Key>, key: Key) =>
    change((stage) => {
      owned(table);
      stageChange(stage, table.name, key, null);
    });
  const replace = <Row extends object>(table: MemoryTable<Row, any>, rows: Iterable<Row>) =>
    change((stage) => {
      owned(table);
      const keep = new Set<MirrorKey>();
      for (const row of rows) {
        const key = table.keyOf(row);
        keep.add(key);
        stageChange(stage, table.name, key, store(table, row));
      }
      for (const key of visibleKeys(stage, table.name)) if (!keep.has(key)) stageChange(stage, table.name, key, null);
    });
  const visibleKeys = (stage: Staged | undefined, table: string) => {
    const keys = new Set(data.get(table)!.keys());
    for (const [key, next] of stage?.get(table) ?? []) {
      if (next === null) keys.delete(key);
      else keys.add(key);
    }
    return keys;
  };
  const get = <Row extends object, Key extends MirrorKey>(table: MemoryTable<Row, Key>, key: Key) => Effect.map(view, (stage) => read(stage, owned(table).name, key)?.row as Row | undefined);
  const rows = <Row extends object>(table: MemoryTable<Row, any>) => Effect.map(view, (stage) => Array.from(visibleKeys(stage, owned(table).name), (key) => read(stage, table.name, key)!.row as Row));

  const decodeRow = (table: AnyMemoryTable, value: unknown) =>
    Effect.try({
      try: () => table.decode(value) as object,
      catch: (cause) => new MirrorRequestError({ message: `Invalid row for "${table.name}": ${cause instanceof Error ? cause.message : String(cause)}` }),
    });

  const applyMutation = (stage: Staged, mutation: MirrorMutation) =>
    Effect.gen(function* () {
      const table = requireTable(mutation.table);
      switch (mutation.type) {
        case "insert": {
          const row = yield* decodeRow(table, mutation.value);
          const key = table.keyOf(row);
          if (read(stage, table.name, key)) return yield* new MirrorRequestError({ message: `Row ${JSON.stringify(key)} already exists in "${table.name}"` });
          return stageChange(stage, table.name, key, store(table, row));
        }
        case "update": {
          const existing = read(stage, table.name, mutation.key);
          if (!existing) return yield* new MirrorRequestError({ message: `Row ${JSON.stringify(mutation.key)} does not exist in "${table.name}"` });
          const row = yield* decodeRow(table, { ...existing.encoded, ...mutation.changes });
          if (table.keyOf(row) !== mutation.key) return yield* new MirrorRequestError({ message: `An update cannot change the key of a row in "${table.name}"` });
          return stageChange(stage, table.name, mutation.key, store(table, row));
        }
        case "delete":
          // Deleting a row that is already gone is a no-op: the requested end state holds.
          return stageChange(stage, table.name, mutation.key, null);
      }
    });

  const mutate = (mutations: ReadonlyArray<MirrorMutation>) =>
    write(
      Effect.gen(function* () {
        const stage = (yield* CurrentWrites).get(id)!;
        for (const mutation of mutations) yield* applyMutation(stage, mutation);
      }),
    ).pipe(Effect.map(() => ({ epoch, seq })));

  const snapshot = (name: string) => Effect.sync(() => ({ epoch, seq, rows: Array.from(data.get(requireTable(name).name)!.values(), (stored) => stored.encoded) }));

  const pull = (fromSeq: number) =>
    Effect.sync(() => {
      if (fromSeq < prunedThroughSeq) return { epoch, kind: "reset" as const };
      const changes = log.filter((change) => change.seq > fromSeq);
      return { epoch, kind: "changes" as const, batch: { epoch, fromSeq, toSeq: Math.max(fromSeq, changes.at(-1)?.seq ?? fromSeq), changes } };
    });

  const dispatch = (request: MirrorRequest): Effect.Effect<MirrorResults[keyof MirrorResults], unknown> => {
    switch (request.type) {
      case "hello":
        return Effect.sync(() => ({ epoch, seq }));
      case "snapshot":
        return snapshot(request.table);
      case "mutate":
        return options.readOnly ? Effect.fail(readOnlyError()) : mutate(request.mutations);
      case "pull":
        return pull(request.fromSeq);
    }
  };

  const handle = handleRequest(dispatch);
  const position = Effect.sync(() => ({ epoch, seq }));

  return { epoch, write, upsert, delete: remove, replace, get, rows, position, handle, subscribe, serve: serveWith(handle, subscribe) } satisfies MemoryMirrorService;
});

export class MemoryMirror extends Context.Service<MemoryMirror, MemoryMirrorService>()("@muswag/tanstack-db-mirror/MemoryMirror") {
  static readonly make = make;
  static readonly layer = (options: MemoryMirrorOptions) => Layer.effect(MemoryMirror, make(options));
}

/** Structural equality for encoded rows: plain data, arrays and dates. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (Object.getPrototypeOf(left) !== Object.prototype || Object.getPrototypeOf(right) !== Object.prototype) return false;
  const leftKeys = Object.keys(left);
  const rightRecord = right as Record<string, unknown>;
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => Object.hasOwn(right, key) && sameValue((left as Record<string, unknown>)[key], rightRecord[key]));
}
