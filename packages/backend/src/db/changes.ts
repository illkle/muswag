import { getColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Context, Duration, Effect, FiberSet, Layer, Option, Schedule, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** A row that was inserted or updated (`changed`) or deleted, by its table and primary key. */
export type LibraryChange = { readonly table: string; readonly type: "changed" | "deleted"; readonly key: string | number };

export interface LibraryChangesOptions {
  /** The tables whose writes are announced. */
  readonly tables: ReadonlyArray<SQLiteTable>;
  /** Columns, by table name and as row property names, whose changes alone are not announced. */
  readonly ignoreColumns?: { readonly [table: string]: ReadonlyArray<string> } | undefined;
  /** Also announces, this often, writes that did not go through `write`. */
  readonly flushInterval?: Duration.Input | undefined;
}

export interface LibraryChangesService {
  /**
   * Runs `effect` in a transaction and announces the rows it changed once it commits. Inside an
   * enclosing transaction it joins that transaction, and the changes are announced after the outer commit.
   */
  readonly write: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>;
  /** Announces the committed changes that have not been announced yet. */
  readonly flush: Effect.Effect<void, SqlError>;
  /** Calls `listener` with the changes of every write, once it has committed. */
  readonly subscribe: (listener: (changes: ReadonlyArray<LibraryChange>) => void) => () => void;
}

/** The temp table the triggers write to, and the prefix of their names. */
const LOG = "__library_changes";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Temporary triggers that log the key of every row a write inserts, updates or deletes in `table`. An
 * update that leaves every watched column as it was, such as an upsert of an unchanged row, logs
 * nothing; a primary-key change logs a delete of the old key and a change of the new one. BINARY, so
 * a case-only change of a NOCASE column still counts. Temporary, so they belong to this connection
 * and a migration never meets a trigger that names a column it changes.
 */
function triggersOf(table: SQLiteTable, ignore: ReadonlyArray<string>): ReadonlyArray<string> {
  const name = getTableName(table);
  const columns = Object.entries(getColumns(table));
  const primary = columns.filter(([, column]) => column.primary);
  if (primary.length !== 1) throw new Error(`Table "${name}" must have exactly one primary-key column for its changes to be announced`);
  for (const key of ignore) if (!columns.some(([property]) => property === key)) throw new Error(`Table "${name}" has no column "${key}" to ignore`);
  const pk = quote(primary[0]![1].name);
  const watched = columns.filter(([property]) => !ignore.includes(property)).map(([, column]) => quote(column.name));
  const changed = watched.map((column) => `OLD.${column} IS NOT NEW.${column} COLLATE BINARY`).join(" OR ");
  const target = `main.${quote(name)}`;
  const log = `temp.${quote(LOG)}`;
  const tbl = literal(name);
  const trigger = (op: string) => quote(`${LOG}__${name}_${op}`);
  return [
    `CREATE TEMP TRIGGER ${trigger("insert")} AFTER INSERT ON ${target} BEGIN
  INSERT INTO ${log} (tbl, op, key) VALUES (${tbl}, 'c', NEW.${pk});
END`,
    `CREATE TEMP TRIGGER ${trigger("update")} AFTER UPDATE ON ${target} WHEN ${changed} BEGIN
  INSERT INTO ${log} (tbl, op, key) SELECT ${tbl}, 'd', OLD.${pk} WHERE OLD.${pk} IS NOT NEW.${pk} COLLATE BINARY;
  INSERT INTO ${log} (tbl, op, key) VALUES (${tbl}, 'c', NEW.${pk});
END`,
    `CREATE TEMP TRIGGER ${trigger("delete")} AFTER DELETE ON ${target} BEGIN
  INSERT INTO ${log} (tbl, op, key) VALUES (${tbl}, 'd', OLD.${pk});
END`,
  ];
}

type LogRow = { readonly seq: number; readonly tbl: string; readonly op: string; readonly key: string | number };

/** What a write did to each row, once: a row changed and then deleted is deleted, and the other way round changed. */
const collapse = (rows: ReadonlyArray<LogRow>): LibraryChange[] => {
  const last = new Map<string, LibraryChange>();
  for (const { tbl, op, key } of rows) {
    const id = `${tbl}\u0000${typeof key}\u0000${key}`;
    last.delete(id);
    last.set(id, { table: tbl, type: op === "d" ? "deleted" : "changed", key });
  }
  return [...last.values()];
};

export const make = Effect.fnUntraced(function* (options: LibraryChangesOptions) {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  // Keys are read as plain numbers, whatever the caller configured.
  const internal = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, SqlClient.SafeIntegers, false);

  // REPLACE conflict resolution fires delete triggers for the rows it removes only with recursive
  // triggers on. The client holds a single connection, so the pragma covers every write.
  yield* sql.unsafe(`PRAGMA recursive_triggers = ON`);
  yield* internal(
    sql.withTransaction(
      Effect.gen(function* () {
        // A service made before on this connection left its triggers and its log.
        const existing = yield* sql.unsafe<{ name: string }>(`SELECT name FROM temp.sqlite_master WHERE type = 'trigger' AND instr(name, ?) = 1`, [`${LOG}__`]);
        for (const { name } of existing) yield* sql.unsafe(`DROP TRIGGER temp.${quote(name)}`);
        // `key` has no declared type, so integer and text keys stay as they were stored.
        yield* sql.unsafe(`CREATE TEMP TABLE IF NOT EXISTS ${quote(LOG)} (seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, op TEXT NOT NULL, key NOT NULL)`);
        yield* sql.unsafe(`DELETE FROM temp.${quote(LOG)}`);
        for (const table of options.tables) {
          for (const statement of triggersOf(table, options.ignoreColumns?.[getTableName(table)] ?? [])) yield* sql.unsafe(statement);
        }
      }),
    ),
  );

  const listeners = new Set<(changes: ReadonlyArray<LibraryChange>) => void>();
  const announce = (changes: ReadonlyArray<LibraryChange>) => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(changes);
      } catch (cause) {
        console.error("[library-changes] a listener failed", cause);
      }
    }
  };

  const flushLock = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make();

  const flushNow = flushLock.withPermits(1)(
    internal(
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<LogRow>(`SELECT seq, tbl, op, key FROM temp.${quote(LOG)} ORDER BY seq`);
        const last = rows.at(-1);
        if (!last) return;
        yield* sql.unsafe(`DELETE FROM temp.${quote(LOG)} WHERE seq <= ?`, [last.seq]);
        announce(collapse(rows));
      }),
    ),
  );

  // After a commit the write has succeeded; changes that could not be announced go with the next flush.
  const flushAfterCommit = flushNow.pipe(Effect.catchCause((cause) => Effect.logError("Announcing library changes failed; the next flush retries", cause)));

  const inTransaction = Effect.map(Effect.serviceOption(sql.transactionService), Option.isSome);

  // Inside an open transaction the log holds uncommitted rows, so the flush runs once the connection is released.
  const flushInBackground = FiberSet.run(
    fibers,
    Effect.updateContext(flushAfterCommit, (context: Context.Context<never>) => Context.omit(sql.transactionService)(context) as Context.Context<never>),
  ).pipe(Effect.asVoid);

  const flush: Effect.Effect<void, SqlError> = Effect.flatMap(inTransaction, (open) => (open ? flushInBackground : flushNow));

  const write = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | SqlError, R> =>
    Effect.flatMap(inTransaction, (open) => (open ? Effect.tap(effect, () => flushInBackground) : Effect.tap(sql.withTransaction(effect), () => flushAfterCommit)));

  if (options.flushInterval !== undefined) {
    yield* flushAfterCommit.pipe(Effect.repeat(Schedule.spaced(options.flushInterval)), Effect.forkScoped);
  }

  const subscribe = (listener: (changes: ReadonlyArray<LibraryChange>) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { write, flush, subscribe } satisfies LibraryChangesService;
});

/** Announces the rows that writes to the library change, to main's own listeners and through them to renderers. */
export class LibraryChanges extends Context.Service<LibraryChanges, LibraryChangesService>()("@muswag/backend/LibraryChanges") {
  static readonly make = make;
  static readonly layer = (options: LibraryChangesOptions) => Layer.effect(LibraryChanges, make(options));
}
