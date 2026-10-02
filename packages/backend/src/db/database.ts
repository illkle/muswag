import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { MIRRORED_TABLES } from "@muswag/model";
import { MirrorServer } from "@muswag/tanstack-db-mirror/server";
import { makeWithDefaults, type EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/sqlite-core/effect";
import { Context, Effect, Layer } from "effect";

import { migrations } from "./migrations.generated.js";

export type Database = EffectSQLiteNodeDatabase;

/** The library database, through Drizzle. Writes to mirrored tables go through `Library.write`. */
export class Db extends Context.Service<Db, Database>()("@muswag/backend/Db") {}

const DbLive = Layer.effect(
  Db,
  Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    // The migrator takes the session, which the database type keeps private; typed through it, the
    // migration would require an unknown context instead of the one the database already has.
    const session = (db as unknown as { readonly session: Parameters<typeof migrate>[1] }).session;
    yield* migrate(migrations, session) as Effect.Effect<undefined, Effect.Error<ReturnType<typeof migrate>>>;
    return db;
  }),
);

/**
 * Mirrors `MIRRORED_TABLES` to renderers, read-only: renderers change data only through commands.
 * The interval only catches writes that bypassed `write`.
 */
const MirrorLive = Layer.effect(MirrorServer, MirrorServer.make({ tables: MIRRORED_TABLES, autoFlushInterval: "2 seconds", readOnly: true })).pipe(Layer.provide(DbLive));

/** The migrated database and its mirror server, on top of a SQLite client. */
export const DatabaseFromClient = Layer.merge(DbLive, MirrorLive);

/** Opens (or creates) the database at `filename` and migrates it. */
export const DatabaseLive = (filename: string) => DatabaseFromClient.pipe(Layer.provideMerge(SqliteClient.layer({ filename })));

/**
 * Commits `effect` in one transaction and pushes the resulting changes to renderers. Every write to a
 * mirrored table should go through here; nested calls join the outer transaction.
 */
export const write = <A, E, R>(effect: Effect.Effect<A, E, R>) => MirrorServer.use((mirror) => mirror.write(effect));

/** The current position of the change stream, for renderers to await a write. */
export const position = MirrorServer.use((mirror) => mirror.position);
