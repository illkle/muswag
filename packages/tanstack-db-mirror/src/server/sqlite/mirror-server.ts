import { is, SQL } from "drizzle-orm";
import { Context, Duration, Effect, FiberSet, Layer, Option, Schedule, Scope, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { MirrorChange, MirrorChangeBatch, MirrorKey, MirrorMutation, MirrorPosition, MirrorRequest, MirrorResponse, MirrorResults, MirrorRow, MirrorServerTransport } from "../../protocol.js";
import { decodeRow, decodeValue, describeTable, encodeValue, MirrorSchemaError, type SqliteMirrorTable, type MirrorTableInfo } from "../../drizzle.js";
import { handleRequest, makeListeners, MirrorRequestError, readOnlyError, serveWith } from "../shared.js";
import { createChangeLogSql, createTriggerSql, quoteIdentifier, rowJson, triggerPrefix } from "./sql.js";

export { MirrorSchemaError };

export interface SqliteMirrorOptions {
  readonly tables: ReadonlyArray<SqliteMirrorTable>;
  /** How many already-broadcast changes to keep for clients recovering from a gap. Defaults to 10 000. */
  readonly retainChanges?: number | undefined;
  /** Name of the change-log table. Defaults to `__mirror_changes`. */
  readonly changeLogTable?: string | undefined;
  /**
   * Flushes on an interval in addition to after every `write`. Only needed when something writes to
   * mirrored tables without going through `write`; such writes are captured but not broadcast until
   * the next flush.
   */
  readonly autoFlushInterval?: Duration.Input | undefined;
  /**
   * Rejects `mutate` requests, so clients can only read and every change goes through `write` in the
   * server process. Pair it with `readOnly` collections on the client.
   */
  readonly readOnly?: boolean | undefined;
}

export interface SqliteMirrorService {
  /** Increases every time a server starts on this database; clients reload when it changes. */
  readonly epoch: number;
  /**
   * Runs `effect` in a transaction and broadcasts the changes it made once it commits. Inside an
   * enclosing transaction it joins that transaction and the broadcast happens after the outer commit.
   */
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  /** Broadcasts committed changes that have not been broadcast yet. */
  readonly flush: Effect.Effect<void, SqlError>;
  /**
   * Latest change position. Inside `write` it includes the transaction's own changes, so a command
   * can return it and the renderer can wait for it with `collection.utils.awaitPosition`.
   */
  readonly position: Effect.Effect<MirrorPosition, SqlError>;
  /** Handles one protocol request. Never fails; errors are returned in the response envelope. */
  readonly handle: (request: unknown) => Effect.Effect<MirrorResponse>;
  readonly subscribe: (listener: (batch: MirrorChangeBatch) => void) => () => void;
  /** Connects a transport for the lifetime of the current scope. */
  readonly serve: (transport: MirrorServerTransport) => Effect.Effect<void, never, Scope.Scope>;
}

type ChangeRow = {
  readonly seq: number;
  readonly tbl: string;
  readonly op: string;
  readonly key_type: string;
  readonly key_json: string | null;
  readonly value: string | null;
};

const DEFAULT_CHANGE_LOG = "__mirror_changes";
const DEFAULT_RETAIN_CHANGES = 10_000;

export const make = Effect.fnUntraced(function* (options: SqliteMirrorOptions) {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  const changeLog = options.changeLogTable ?? DEFAULT_CHANGE_LOG;
  const changeLogSql = quoteIdentifier(changeLog);
  const retainChanges = options.retainChanges ?? DEFAULT_RETAIN_CHANGES;
  const metaSql = quoteIdentifier(`${changeLog}_meta`);

  const tables = new Map<string, MirrorTableInfo>();
  for (const table of options.tables) {
    const info = yield* Effect.try({ try: () => describeTable(table), catch: (cause) => cause as MirrorSchemaError });
    if (tables.has(info.name)) {
      return yield* Effect.fail(new MirrorSchemaError(`Table "${info.name}" is registered twice`));
    }
    tables.set(info.name, info);
  }

  // The server's own queries always read plain numbers, whatever the caller configured.
  const internal = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, SqlClient.SafeIntegers, false);

  const currentSeq = internal(sql.unsafe<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = ?`, [changeLog])).pipe(Effect.map((rows) => rows[0]?.seq ?? 0));

  // REPLACE conflict resolution only fires delete triggers for the rows it removes when recursive
  // triggers are on. The client holds a single connection, so the pragma covers every write.
  yield* sql.unsafe(`PRAGMA recursive_triggers = ON`);
  const { epoch, startSeq } = yield* internal(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(createChangeLogSql(changeLog));
        yield* sql.unsafe(`CREATE TABLE IF NOT EXISTS ${metaSql} (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
        // Seeded from the clock so a replaced database file still moves the epoch forward.
        const [row] = yield* sql.unsafe<{ value: number }>(
          `INSERT INTO ${metaSql} (key, value) VALUES ('epoch', ?) ON CONFLICT(key) DO UPDATE SET value = max(value + 1, excluded.value) RETURNING value`,
          [Date.now()],
        );
        // A server started before on this connection left its triggers in `temp`; versions that stored
        // them in the database file left them in `main`.
        for (const schema of ["temp", "main"]) {
          const existing = yield* sql.unsafe<{ name: string }>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'trigger' AND instr(name, ?) = 1`, [triggerPrefix(changeLog)]);
          for (const { name } of existing) {
            yield* sql.unsafe(`DROP TRIGGER ${schema}.${quoteIdentifier(name)}`);
          }
        }
        for (const info of tables.values()) {
          for (const statement of createTriggerSql(info, changeLog)) {
            yield* sql.unsafe(statement);
          }
        }
        // Clients of a previous server instance reload on the new epoch, so the old log is useless.
        yield* sql.unsafe(`DELETE FROM ${changeLogSql}`);
        return { epoch: row!.value, startSeq: yield* currentSeq };
      }),
    ),
  );

  let lastFlushedSeq = startSeq;
  let prunedThroughSeq = startSeq;
  const { subscribe, broadcast } = makeListeners();
  const flushLock = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make();

  const requireTable = (name: string) => {
    const info = tables.get(name);
    if (!info) throw new MirrorRequestError({ message: `Table "${name}" is not mirrored` });
    return info;
  };

  const decodeChange = (row: ChangeRow): MirrorChange => {
    const info = requireTable(row.tbl);
    // Keys are read as JSON, formatted like the row values: node:sqlite throws on integers beyond
    // Number.MAX_SAFE_INTEGER, and a text cast would turn real keys into strings.
    if (row.key_json === null) throw new Error(`Key of type ${row.key_type} of "${row.tbl}" cannot be mirrored`);
    const rawKey: unknown = JSON.parse(row.key_json);
    if (row.key_type === "integer" && !Number.isSafeInteger(rawKey)) throw new Error(`Key ${row.key_json} of "${row.tbl}" is outside the safe integer range`);
    const key = decodeValue(info.primaryKey.column, rawKey) as MirrorKey;
    if (row.op === "d") return { seq: row.seq, table: row.tbl, type: "delete", key };
    return { seq: row.seq, table: row.tbl, type: "upsert", key, value: decodeRow(info, row.value ?? "{}") };
  };

  // A change that cannot be decoded is skipped rather than allowed to block every later change.
  const decodeChanges = (rows: ReadonlyArray<ChangeRow>) =>
    rows.flatMap((row) => {
      try {
        return [decodeChange(row)];
      } catch (cause) {
        console.error(`[tanstack-db-mirror] skipping change ${row.seq} of "${row.tbl}" that cannot be mirrored`, cause);
        return [];
      }
    });

  const readChangesAfter = (seq: number) =>
    internal(
      sql.unsafe<ChangeRow>(
        `SELECT seq, tbl, op, typeof(key) AS key_type, CASE WHEN typeof(key) = 'blob' THEN NULL ELSE json_quote(key) END AS key_json, value FROM ${changeLogSql} WHERE seq > ? ORDER BY seq`,
        [seq],
      ),
    ).pipe(Effect.map((rows) => ({ toSeq: rows.at(-1)?.seq, changes: decodeChanges(rows) })));

  const inTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

  const flushNow = flushLock.withPermits(1)(
    Effect.gen(function* () {
      const { toSeq, changes } = yield* readChangesAfter(lastFlushedSeq);
      if (toSeq === undefined) return;

      const batch: MirrorChangeBatch = { epoch, fromSeq: lastFlushedSeq, toSeq, changes };
      lastFlushedSeq = toSeq;
      broadcast(batch);

      if (lastFlushedSeq - prunedThroughSeq > retainChanges * 2) {
        const cutoff = lastFlushedSeq - retainChanges;
        // Advance before deleting so a concurrent pull never reads a partially pruned range.
        prunedThroughSeq = cutoff;
        yield* internal(sql.unsafe(`DELETE FROM ${changeLogSql} WHERE seq <= ?`, [cutoff]));
      }
    }),
  );

  // After a commit the write has succeeded; a failed broadcast is retried by the next flush.
  const flushAfterCommit = flushNow.pipe(Effect.catchCause((cause) => Effect.logError("Mirror flush failed; it will be retried on the next flush", cause)));

  // Reading the log inside an open transaction would see uncommitted rows, so a flush requested
  // there runs in the background once the connection is released.
  const flushInBackground = FiberSet.run(
    fibers,
    Effect.updateContext(flushAfterCommit, (context: Context.Context<never>) => Context.omit(sql.transactionService)(context) as Context.Context<never>),
  ).pipe(Effect.asVoid);

  const flush: Effect.Effect<void, SqlError> = Effect.flatMap(inTransaction, (open) => (open ? flushInBackground : flushNow));

  const write = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    Effect.flatMap(inTransaction, (open) => (open ? Effect.tap(effect, () => flushInBackground) : Effect.tap(sql.withTransaction(effect), () => flushAfterCommit)));

  const snapshot = (tableName: string) =>
    Effect.suspend(() => {
      const info = requireTable(tableName);
      const table = quoteIdentifier(info.name);
      return internal(
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{ value: string }>(`SELECT ${rowJson(info, table)} AS value FROM ${table}`);
            const seq = yield* currentSeq;
            return { epoch, seq, rows: rows.map((row) => decodeRow(info, row.value)) };
          }),
        ),
      );
    });

  const applyMutation = (mutation: MirrorMutation) =>
    Effect.suspend(() => {
      const info = requireTable(mutation.table);
      const table = quoteIdentifier(info.name);
      const pk = info.primaryKey;

      switch (mutation.type) {
        case "insert": {
          const { names, values } = encodeInsert(info, mutation.value);
          const statement = names.length === 0 ? `INSERT INTO ${table} DEFAULT VALUES` : `INSERT INTO ${table} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
          return Effect.asVoid(sql.unsafe(statement, values));
        }
        case "update": {
          const { names, values } = encodeUpdate(info, mutation.changes);
          if (names.length === 0) return Effect.void;
          const assignments = names.map((name) => `${quoteIdentifier(name)} = ?`).join(", ");
          const statement = `UPDATE ${table} SET ${assignments} WHERE ${quoteIdentifier(pk.name)} = ? RETURNING 1 AS found`;
          return sql
            .unsafe(statement, [...values, encodeValue(pk.column, mutation.key)])
            .pipe(
              Effect.flatMap((rows) => (rows.length === 0 ? Effect.fail(new MirrorRequestError({ message: `Row ${JSON.stringify(mutation.key)} does not exist in "${info.name}"` })) : Effect.void)),
            );
        }
        case "delete": {
          // Deleting a row that is already gone is a no-op: the requested end state holds.
          return Effect.asVoid(sql.unsafe(`DELETE FROM ${table} WHERE ${quoteIdentifier(pk.name)} = ?`, [encodeValue(pk.column, mutation.key)]));
        }
      }
    });

  const mutate = (mutations: ReadonlyArray<MirrorMutation>) =>
    write(
      Effect.gen(function* () {
        for (const mutation of mutations) {
          yield* applyMutation(mutation);
        }
        return yield* currentSeq;
      }),
    ).pipe(Effect.map((seq) => ({ epoch, seq })));

  const pull = (fromSeq: number) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (fromSeq < prunedThroughSeq) return { epoch, kind: "reset" as const };
        const { toSeq, changes } = yield* readChangesAfter(fromSeq);
        return { epoch, kind: "changes" as const, batch: { epoch, fromSeq, toSeq: Math.max(fromSeq, toSeq ?? fromSeq), changes } };
      }),
    );

  const dispatch = (request: MirrorRequest): Effect.Effect<MirrorResults[keyof MirrorResults], unknown> => {
    switch (request.type) {
      case "hello":
        return Effect.succeed({ epoch, seq: lastFlushedSeq });
      case "snapshot":
        return snapshot(request.table);
      case "mutate":
        return options.readOnly ? Effect.fail(readOnlyError()) : mutate(request.mutations);
      case "pull":
        return pull(request.fromSeq);
    }
  };

  const handle = handleRequest(dispatch);
  const serve = serveWith(handle, subscribe);

  if (options.autoFlushInterval !== undefined) {
    yield* flushNow.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Mirror auto flush failed", cause)),
      Effect.repeat(Schedule.spaced(options.autoFlushInterval)),
      Effect.forkScoped,
    );
  }

  const position = Effect.map(currentSeq, (seq) => ({ epoch, seq }));

  return { epoch, write, flush, position, handle, subscribe, serve } satisfies SqliteMirrorService;
});

export class SqliteMirror extends Context.Service<SqliteMirror, SqliteMirrorService>()("@muswag/tanstack-db-mirror/SqliteMirror") {
  static readonly make = make;
  static readonly layer = (options: SqliteMirrorOptions) => Layer.effect(SqliteMirror, make(options));
}

function encodeInsert(info: MirrorTableInfo, value: MirrorRow) {
  assertKnownColumns(info, value);
  const names: Array<string> = [];
  const values: Array<unknown> = [];
  for (const { key, name, column } of info.columns) {
    if (column.generated) continue;
    let next = value[key];
    if (next === undefined) {
      const runtimeDefault = column.defaultFn ?? column.onUpdateFn;
      if (!runtimeDefault) continue;
      next = runtimeDefault();
    }
    names.push(name);
    values.push(encodeColumnValue(info, name, column, next));
  }
  return { names, values };
}

function encodeUpdate(info: MirrorTableInfo, changes: MirrorRow) {
  assertKnownColumns(info, changes);
  const names: Array<string> = [];
  const values: Array<unknown> = [];
  for (const { key, name, column } of info.columns) {
    if (column.generated || !(key in changes)) continue;
    names.push(name);
    values.push(encodeColumnValue(info, name, column, changes[key]));
  }
  if (names.length === 0) return { names, values };
  for (const { key, name, column } of info.columns) {
    if (key in changes || !column.onUpdateFn) continue;
    names.push(name);
    values.push(encodeColumnValue(info, name, column, column.onUpdateFn()));
  }
  return { names, values };
}

function encodeColumnValue(info: MirrorTableInfo, name: string, column: MirrorTableInfo["columns"][number]["column"], value: unknown) {
  if (is(value, SQL)) {
    throw new MirrorRequestError({ message: `Column "${info.name}.${name}" produced a SQL expression; mirrored writes only support plain values` });
  }
  return encodeValue(column, value);
}

// `$`-prefixed keys are TanStack DB virtual properties.
function assertKnownColumns(info: MirrorTableInfo, row: MirrorRow) {
  for (const key of Object.keys(row)) {
    if (!key.startsWith("$") && !info.columnsByKey.has(key)) {
      throw new MirrorRequestError({ message: `Unknown column "${key}" for table "${info.name}"` });
    }
  }
}
