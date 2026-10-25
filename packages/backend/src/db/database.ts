import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { MIRROR_OMITTED_COLUMNS, MIRRORED_TABLES } from "@muswag/model";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { makeWithDefaults, type EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { Context, Effect, Layer } from "effect";

import { migrations } from "./migrations.generated.js";

export type Database = EffectSQLiteNodeDatabase;

/** The library database, through Drizzle. Writes to mirrored tables go through `write`, below. */
export class Db extends Context.Service<Db, Database>()("@muswag/backend/Db") {}

const DbLive = Layer.effect(
  Db,
  Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    // In WAL mode a commit that does not wait for the disk can only be lost with the machine, not
    // with the app, and the database stays whole either way. Every write then costs no fsync.
    yield* db.run(sql`PRAGMA synchronous = NORMAL`);
    // Brings the query planner's statistics up to date for the queries this session ran, which costs
    // little once they are, as it is on every close after the first.
    yield* Effect.addFinalizer(() => Effect.ignore(db.run(sql`PRAGMA optimize`)));
    // The migrator takes the session, which the database type keeps private; typed through it, the
    // migration would require an unknown context instead of the one the database already has.
    const session = (db as unknown as { readonly session: Parameters<typeof migrate>[1] }).session;
    yield* migrate(migrations, session) as Effect.Effect<undefined, Effect.Error<ReturnType<typeof migrate>>>;
    return db;
  }),
);

/**
 * Mirrors `MIRRORED_TABLES` to renderers, read-only: renderers change data only through commands.
 * Columns only main reads stay out of it. The library has too many songs and albums for a renderer to
 * hold, so renderers read them by the page and a change of either carries only its id.
 */
const MirrorLive = Layer.effect(SqliteMirror, SqliteMirror.make({ tables: MIRRORED_TABLES, omitColumns: MIRROR_OMITTED_COLUMNS, keyOnlyTables: ["songs", "albums"] })).pipe(Layer.provide(DbLive));

/** Opens (or creates) the database at `filename`, migrates it and starts its mirror server. */
export const DatabaseLive = (filename: string) => Layer.merge(DbLive, MirrorLive).pipe(Layer.provideMerge(SqliteClient.layer({ filename })));

/**
 * Commits `effect` in one transaction and pushes the resulting changes to renderers. Every write to a
 * mirrored table goes through here: one made any other way reaches renderers only with the next write
 * that does. Nested calls join the outer transaction.
 */
export const write = <A, E, R>(effect: Effect.Effect<A, E, R>) => SqliteMirror.use((mirror) => mirror.write(effect));

/** The current position of the change stream, for renderers to await a write. */
export const position = SqliteMirror.use((mirror) => mirror.position);
