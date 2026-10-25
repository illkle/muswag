import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { ANNOUNCED_TABLES, UNANNOUNCED_COLUMNS } from "@muswag/model";
import { makeWithDefaults, type EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import * as SqlClient from "effect/sql/SqlClient";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { Context, Effect, Layer } from "effect";

import { LibraryChanges } from "./changes.js";
import { migrations } from "./migrations.generated.js";

export type Database = EffectSQLiteNodeDatabase;

/** The library database, through Drizzle. Writes to `ANNOUNCED_TABLES` go through `write`, below. */
export class Db extends Context.Service<Db, Database>()("@muswag/backend/Db") {}

/**
 * Drops what the mirror that came before left in the database file: its change log and, from its
 * oldest versions, capture triggers, which would stop a migration that changes a column they name.
 */
const dropMirrorLeftovers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const triggers = yield* sql.unsafe<{ name: string }>(`SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND instr(name, '__mirror_changes__') = 1`);
  for (const { name } of triggers) yield* sql.unsafe(`DROP TRIGGER main."${name.replaceAll('"', '""')}"`);
  yield* sql.unsafe(`DROP TABLE IF EXISTS main."__mirror_changes"`);
  yield* sql.unsafe(`DROP TABLE IF EXISTS main."__mirror_changes_meta"`);
});

const DbLive = Layer.effect(
  Db,
  Effect.gen(function* () {
    yield* dropMirrorLeftovers;
    const db = yield* makeWithDefaults();
    // The migrator takes the session, which the database type keeps private; typed through it, the
    // migration would require an unknown context instead of the one the database already has.
    const session = (db as unknown as { readonly session: Parameters<typeof migrate>[1] }).session;
    yield* migrate(migrations, session) as Effect.Effect<undefined, Effect.Error<ReturnType<typeof migrate>>>;
    return db;
  }),
);

/**
 * Announces which rows of `ANNOUNCED_TABLES` each write changed, by key: main's search and queue read
 * what they need again, and renderers hear which tables changed. A change only to columns renderers
 * never get is not one. The interval only catches writes that bypassed `write`.
 */
const ChangesLive = LibraryChanges.layer({ tables: ANNOUNCED_TABLES, ignoreColumns: UNANNOUNCED_COLUMNS, flushInterval: "2 seconds" }).pipe(Layer.provide(DbLive));

/** Opens (or creates) the database at `filename`, migrates it and starts announcing its changes. */
export const DatabaseLive = (filename: string) => Layer.merge(DbLive, ChangesLive).pipe(Layer.provideMerge(SqliteClient.layer({ filename })));

/**
 * Commits `effect` in one transaction and announces the rows it changed. Every write to an announced
 * table should go through here; nested calls join the outer transaction.
 */
export const write = <A, E, R>(effect: Effect.Effect<A, E, R>) => LibraryChanges.use((changes) => changes.write(effect));
