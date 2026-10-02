import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { createCollection, type Collection } from "@tanstack/db";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vitest";

import { createMirrorClient, mirrorCollectionOptions, type MirrorClient, type MirrorClientOptions, type MirrorCollectionUtils } from "../client/index.js";
import type { MirrorRow } from "../protocol.js";
import { SqliteMirror, type SqliteMirrorOptions, type SqliteMirrorService } from "../server/sqlite/index.js";
import type { MirrorRowOf } from "../table.js";
import { createMemoryTransport, type MemoryConnection, type MemoryTransportOptions } from "../testing/index.js";

export const albums = sqliteTable("albums", {
  id: text().primaryKey(),
  name: text().notNull(),
  artistId: text("artist_id"),
  starred: integer({ mode: "boolean" }),
  created: integer({ mode: "timestamp" }),
  extra: text({ mode: "json" }).$type<{ tags: Array<string> }>(),
  plays: integer().notNull().default(0),
  slug: text().unique(),
});

let tick = 1_000;
export const songs = sqliteTable("songs", {
  id: integer().primaryKey(),
  albumId: text("album_id")
    .notNull()
    .references(() => albums.id, { onDelete: "cascade" }),
  title: text().notNull(),
  rating: integer().$defaultFn(() => 3),
  updatedAt: integer("updated_at").$onUpdateFn(() => ++tick),
});

export const unmirrored = sqliteTable("unmirrored", {
  id: text().primaryKey(),
});

export const SCHEMA = [
  `CREATE TABLE albums (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    artist_id TEXT,
    starred INTEGER,
    created INTEGER,
    extra TEXT,
    plays INTEGER NOT NULL DEFAULT 0,
    slug TEXT UNIQUE
  )`,
  `CREATE TABLE songs (
    id INTEGER PRIMARY KEY,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    rating INTEGER,
    updated_at INTEGER
  )`,
  `CREATE TABLE unmirrored (id TEXT PRIMARY KEY)`,
];

export type AlbumRow = MirrorRowOf<typeof albums>;
export type SongRow = MirrorRowOf<typeof songs>;

export const album = (id: string, overrides: Partial<AlbumRow> = {}): AlbumRow => ({
  id,
  name: `Album ${id}`,
  artistId: null,
  starred: null,
  created: null,
  extra: null,
  plays: 0,
  slug: null,
  ...overrides,
});

export const song = (id: number, albumId: string, overrides: Partial<SongRow> = {}): SongRow => ({
  id,
  albumId,
  title: `Song ${id}`,
  rating: 3,
  updatedAt: null,
  ...overrides,
});

export type HarnessOptions = {
  readonly latency?: MemoryTransportOptions["latency"];
  readonly server?: Partial<SqliteMirrorOptions>;
};

export type ConnectedClient = {
  readonly connection: MemoryConnection;
  readonly client: MirrorClient;
  readonly albums: Collection<AlbumRow, string, MirrorCollectionUtils>;
  readonly songs: Collection<SongRow, number, MirrorCollectionUtils>;
};

type Runtime = ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never>;

export async function createHarness(options: HarnessOptions = {}) {
  const runtime: Runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ":memory:" }) as Layer.Layer<SqlClient.SqlClient>);
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(effect);
  const sql = await run(Effect.service(SqlClient.SqlClient));

  await run(
    Effect.gen(function* () {
      yield* sql.unsafe(`PRAGMA foreign_keys = ON`);
      for (const statement of SCHEMA) yield* sql.unsafe(statement);
    }),
  );

  const transport = createMemoryTransport({ latency: options.latency });
  const serverOptions: SqliteMirrorOptions = { tables: [albums, songs], ...options.server };

  let serverScope: Scope.Closeable | null = null;
  let server!: SqliteMirrorService;

  const startServer = async () => {
    if (serverScope) await run(Scope.close(serverScope, Exit.void));
    const scope = await run(Scope.make());
    serverScope = scope;
    server = await run(
      Effect.gen(function* () {
        const next = yield* SqliteMirror.make(serverOptions);
        yield* next.serve(transport.server);
        return next;
      }).pipe(Scope.provide(scope)),
    );
    return server;
  };
  await startServer();

  const clients: Array<ConnectedClient> = [];

  const connect = (clientOptions: Partial<Omit<MirrorClientOptions, "transport">> & { latency?: MemoryTransportOptions["latency"] } = {}): ConnectedClient => {
    const { latency, ...rest } = clientOptions;
    const connection = transport.connect({ latency });
    const client = createMirrorClient({ transport: connection, ...rest });
    const connected: ConnectedClient = {
      connection,
      client,
      albums: createCollection(mirrorCollectionOptions({ client, table: albums })),
      songs: createCollection(mirrorCollectionOptions({ client, table: songs })),
    };
    clients.push(connected);
    return connected;
  };

  /** Runs `effect` through `SqliteMirror.write`, so its changes are broadcast. */
  const write = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => run(server.write(effect));
  const exec = (statement: string, params: ReadonlyArray<unknown> = []) => write(sql.unsafe(statement, params));

  const insertAlbums = (rows: ReadonlyArray<AlbumRow>) =>
    write(
      Effect.forEach(rows, (row) =>
        sql.unsafe(`INSERT INTO albums (id, name, artist_id, starred, created, extra, plays, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
          row.id,
          row.name,
          row.artistId,
          row.starred === null ? null : row.starred ? 1 : 0,
          row.created === null ? null : Math.floor(row.created.getTime() / 1000),
          row.extra === null ? null : JSON.stringify(row.extra),
          row.plays,
          row.slug,
        ]),
      ),
    );

  const insertSongs = (rows: ReadonlyArray<SongRow>) =>
    write(Effect.forEach(rows, (row) => sql.unsafe(`INSERT INTO songs (id, album_id, title, rating, updated_at) VALUES (?, ?, ?, ?, ?)`, [row.id, row.albumId, row.title, row.rating, row.updatedAt])));

  /** Decoded table contents, read through the server's own snapshot path. */
  const dbRows = async (table: "albums" | "songs"): Promise<Array<MirrorRow>> => {
    const response = await run(server.handle({ v: 1, type: "snapshot", table }));
    if (!response.ok) throw new Error(response.error.message);
    return sortRows([...(response.result as unknown as { rows: Array<MirrorRow> }).rows]);
  };

  const dispose = async () => {
    for (const { client, albums: albumCollection, songs: songCollection, connection } of clients) {
      await Promise.all([albumCollection.cleanup(), songCollection.cleanup()]);
      client.dispose();
      connection.close();
    }
    if (serverScope) await run(Scope.close(serverScope, Exit.void));
    await runtime.dispose();
  };

  return {
    run,
    sql,
    transport,
    get server() {
      return server;
    },
    startServer,
    connect,
    write,
    exec,
    insertAlbums,
    insertSongs,
    dbRows,
    dispose,
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/** Collection contents without TanStack DB's `$`-prefixed virtual properties. */
export const rowsOf = (collection: Collection<any, any, any>): Array<MirrorRow> => sortRows(collection.toArray.map(stripVirtual));

export const stripVirtual = (row: object): MirrorRow => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("$")));

export function sortRows(rows: Array<MirrorRow>): Array<MirrorRow> {
  return rows.sort((left, right) => String(left.id).localeCompare(String(right.id), "en", { numeric: true }));
}

/** Polls until the assertion passes, failing with its last error after `timeoutMs`. */
export async function eventually(assertion: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Waits until both collections of `connected` equal the database. */
export async function expectInSync(harness: Harness, connected: ConnectedClient, timeoutMs?: number): Promise<void> {
  await eventually(async () => {
    expect(rowsOf(connected.albums)).toEqual(await harness.dbRows("albums"));
    expect(rowsOf(connected.songs)).toEqual(await harness.dbRows("songs"));
  }, timeoutMs);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Small seeded PRNG so failures reproduce. */
export function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
