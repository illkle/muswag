# @muswag/tanstack-db-mirror

TanStack DB collections that mirror data owned by another process. In Electron, the main process owns the data and the renderer gets live, optimistic collections on top of it.

Two kinds of server feed the same client and the same collections:

- **`SqliteMirror`** serves Drizzle tables in SQLite. SQLite is the source of truth: triggers capture every write to a mirrored table, including bulk `UPDATE … WHERE`, foreign-key cascades and `REPLACE` conflicts. Use it for data that must survive a restart.
- **`MemoryMirror`** serves tables kept in memory and defined by an Effect Schema. Use it for state that lives only as long as the process, such as what a player is doing, without writing it to disk or waiting on the database connection.

What both have in common:

- **Renderer mutations are optimistic.** `collection.insert/update/delete` writes through the main process. It resolves once the resulting change has come back through the stream, so the optimistic state is replaced by synced state in one step, without flicker.
- **One schema per table.** Row and key types come from the Drizzle table or the Effect Schema, and values are encoded and decoded with it: booleans, timestamps, JSON and transformed values arrive as JS values.
- **One query layer.** Collections of either kind are ordinary TanStack DB collections, so a live query can join a memory table with a SQLite one. The two sources are not synchronised with each other: when main changes both at once, a join can briefly see one change before the other.

## How it works

```
 main process (SqliteMirror or MemoryMirror)          renderer (MirrorClient + collections)
 ┌──────────────────────────────┐   hello/snapshot/   ┌──────────────────────────────┐
 │ tables ─────────────► change │◄── mutate/pull ─────│ mirrorCollectionOptions(...) │
 │                       log    │                     │   eager snapshot, then       │
 │ write(effect) ─commit─► flush├──── change batch ──►│   apply ordered change batch │
 └──────────────────────────────┘                     └──────────────────────────────┘
```

Both servers speak the same protocol:

- **Change log.** Every change gets a sequence number (`seq`). A server broadcasts each committed write's changes as one batch covering `(fromSeq, toSeq]`, and keeps recent changes so that clients can pull a range they missed.
- **Gap recovery.** The client tracks the last contiguous `seq` it has delivered. If a batch starts after that point, it pulls the missing range. If that range has been pruned, every collection reloads.
- **Heartbeat.** A connected client asks the server for its position every few seconds (`heartbeatMs`, default 5 000). If the server is ahead, the client pulls what it is missing, so a lost batch is recovered even when nothing later reveals the gap. A restart that sent nothing yet is noticed the same way.
- **Restarts.** Each server start takes a new `epoch`, seeded from the clock so that it still moves forward across processes and replaced database files. Clients reload when they see a newer epoch. A lower one is usually a replaced server answering late; the client checks with `hello` and only reconnects if that server is actually the live one.
- **Loading.** A collection subscribes to the stream, takes a snapshot of its table at a known `seq`, then applies only the changes after it. Collections are eager: the whole table is held in memory.
- **Mutations.** A request's mutations are applied in one write. The server returns the resulting position, and the handler waits until the collection has synced up to it. If the stream hasn't caught up shortly afterwards, the client pulls the missing range.

How each server produces its changes:

- **SQLite.** Each mirrored table gets `AFTER INSERT/UPDATE/DELETE` triggers. They append the row to `__mirror_changes` as `json_object(...)`, under an `AUTOINCREMENT` `seq`. `SqliteMirror.write(effect)` runs the effect in a transaction and broadcasts after it commits. If broadcasting fails, the error is logged and the next flush retries. A captured change that can't be decoded is logged and skipped, so it doesn't block later changes.
- **Memory.** `MemoryMirror.write(effect)` holds the effect's changes aside and applies them only if it succeeds, then broadcasts one batch with the end state of each row it touched. A row rewritten with an equal value produces no change. Rows are encoded with the table's schema when written; clients decode them on arrival and skip, with an error log, any row that does not decode.

## Usage

Define tables once, in code both processes can import:

```ts
// schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const albums = sqliteTable("albums", {
  id: text().primaryKey(),
  name: text().notNull(),
  starred: integer({ mode: "boolean" }),
  extra: text({ mode: "json" }).$type<{ tags: string[] }>(),
});
```

### SQLite tables

Main process. The tables must exist before the server starts, so run migrations first. The server lives as long as its scope, so provide it as a layer:

```ts
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import { eq } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { ipcMain } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";

const MirrorLive = Layer.effect(
  SqliteMirror,
  Effect.gen(function* () {
    const mirror = yield* SqliteMirror.make({ tables: [albums] });
    yield* mirror.serve(createElectronMainTransport({ ipcMain }));
    return mirror;
  }),
);
const runtime = ManagedRuntime.make(MirrorLive.pipe(Layer.provideMerge(Migrations), Layer.provideMerge(SqliteClient.layer({ filename: dbPath }))));

// Everything inside `write` commits together and is broadcast after the commit.
const starAlbum = (id: string) =>
  Effect.gen(function* () {
    const mirror = yield* SqliteMirror;
    const db = yield* makeWithDefaults(); // Drizzle on the same connection; create it once in real code
    return yield* mirror.write(
      Effect.gen(function* () {
        yield* db.update(albums).set({ starred: true }).where(eq(albums.id, id));
        return yield* mirror.position; // lets the renderer await this write
      }),
    );
  });
```

Renderer:

```ts
import { createCollection } from "@tanstack/react-db";
import { createMirrorClient, mirrorCollectionOptions } from "@muswag/tanstack-db-mirror/client";
import { createElectronRendererTransport } from "@muswag/tanstack-db-mirror/electron/renderer";

const client = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer: window.electron.ipcRenderer }) });

export const albumsCollection = createCollection(mirrorCollectionOptions({ client, table: albums }));
// Collection<{ id: string; name: string; starred: boolean | null; extra: { tags: string[] } | null }, string>

albumsCollection.update("a1", (draft) => {
  draft.starred = true;
}); // optimistic; persisted when the change syncs back
```

To write to several collections atomically, use `client.applyTransaction` as the transaction's mutation function:

```ts
const tx = createTransaction({ mutationFn: ({ transaction }) => client.applyTransaction(transaction) });
tx.mutate(() => {
  albumsCollection.insert(album);
  songsCollection.insert(songs);
});
```

When a main-process command returns the position from its `write`, as `starAlbum` does, the renderer can wait for its effects with `collection.utils.awaitPosition(position)`.

### Memory tables

Define a memory table from an Effect Schema and the property that identifies a row. The schema must encode to a plain object that survives structured cloning; transformations such as `DateFromMillis` are applied on the way out and undone on arrival.

```ts
// state.ts
import { memoryTable } from "@muswag/tanstack-db-mirror/memory";
import { Schema } from "effect";

export const Playback = Schema.Struct({
  id: Schema.Literal("current"),
  status: Schema.Union([Schema.TaggedStruct("Idle", {}), Schema.TaggedStruct("Playing", { trackId: Schema.String })]),
  startedAt: Schema.NullOr(Schema.DateFromMillis),
});
export const playback = memoryTable("playback", Playback, { primaryKey: "id" });
```

Main process. Serve memory tables on their own channel, so their stream is separate from the SQLite one:

```ts
import { MemoryMirror } from "@muswag/tanstack-db-mirror/server/memory";

const StateLive = Layer.effect(
  MemoryMirror,
  Effect.gen(function* () {
    const mirror = yield* MemoryMirror.make({ tables: [playback], readOnly: true });
    yield* mirror.serve(createElectronMainTransport({ ipcMain, channel: "app-state" }));
    return mirror;
  }),
);

// One batch, or nothing if the effect fails. Reads inside `write` see its own changes.
const play = (trackId: string) =>
  Effect.gen(function* () {
    const mirror = yield* MemoryMirror;
    yield* mirror.write(mirror.upsert(playback, { id: "current", status: { _tag: "Playing", trackId }, startedAt: new Date() }));
    return yield* mirror.position; // positions are assigned on commit, so read it after the write
  });
```

`upsert`, `delete` and `replace` (which sets a table's whole contents) are writes of their own when called outside `write`. A row that does not satisfy the schema is a defect.

Renderer: a second client on the same channel; collections are created the same way.

```ts
const stateClient = createMirrorClient({ transport: createElectronRendererTransport({ ipcRenderer, channel: "app-state" }) });
export const playbackCollection = createCollection(mirrorCollectionOptions({ client: stateClient, table: playback, readOnly: true }));
```

A position belongs to the server that returned it: await it on a collection of that server's client.

### Read-only mirrors

If every change should go through your own main-process commands, turn off renderer writes on both sides. The server then rejects `mutate` requests, so a renderer can't write to mirrored tables even if its code is compromised. The collections leave out their mutation handlers, so `insert`, `update` and `delete` throw in the renderer instead of reaching the server. Commands return a position for `awaitPosition` as above.

```ts
SqliteMirror.make({ tables: [albums, songs], readOnly: true }); // main
mirrorCollectionOptions({ client, table: albums, readOnly: true }); // renderer
```

## Rules and limits

### Memory tables

- **Data lives as long as the server.** A restarted process starts with empty tables, and clients reload to match.
- **No isolation between writes.** When two concurrent writes change the same row, the one that finishes last wins.
- **Keys** are one string or finite-number property of the row.
- **Mutations from the renderer** send whole encoded rows, because a schema cannot encode part of a row. An update merges them into the stored row and decodes the result, so it must still satisfy the schema.

### SQLite tables

- **Write through `mirror.write`.** Writes made any other way are still captured, but they aren't broadcast until the next `write` or `mirror.flush`. `autoFlushInterval` adds a periodic backstop.
- **Primary keys:** single-column only. A primary-key change is mirrored as a delete followed by an insert.
- **Supported columns:** text, JSON text, integer, boolean, timestamp, real and numeric (string or number mode). Custom column types are allowed but must not store blobs. Blob and bigint columns are rejected at startup. At most 63 columns per table, because of SQLite's limit on function arguments.
- **Integers** must stay within `Number.MAX_SAFE_INTEGER`. Larger keys are skipped with an error log, and larger values in other columns are rounded.
- **Column names** come from the Drizzle table definition. Drizzle's database-level `casing` option is not applied, so name columns explicitly instead of relying on it.
- **Runtime defaults:** `$defaultFn` and `$onUpdateFn` are applied to mutations from the renderer. Defaults written as SQL expressions are not.
- **One connection.** The server relies on Effect's single-connection SQLite client: it turns on `PRAGMA recursive_triggers` (so rows removed by `REPLACE` produce delete events), and it detects open transactions through `sql.withTransaction`. Raw `BEGIN` statements, other connections and other processes writing the same file aren't covered. `recursive_triggers` also applies to your own triggers on that connection.
- **Schema changes:** triggers are rebuilt from the table definitions at every start, so migrations don't need to know about them. Exclude `__mirror_changes` and `__mirror_changes_meta` from drizzle-kit (`tablesFilter`). Capture triggers are named `__mirror_changes__<table>_<op>`; only those are dropped on restart.

### Both

- **Electron renderer transport:** pass an `ipcRenderer` whose `on` returns an unsubscribe function, such as the one `@electron-toolkit/preload` exposes. With the raw `ipcRenderer` behind `contextBridge`, `removeListener` can't match the proxied listener, so the listener leaks when the client is disposed.
- **Drizzle:** the server reads table metadata and value codecs from Drizzle and runs its own SQL through Effect's `SqlClient`. It is built against `drizzle-orm@1.0.0-rc.5` (a nightly; `rc.4`'s Effect driver does not run on `effect@4.0.0`), which decodes values through per-type codecs, so upgrades should be deliberate pin bumps. Application code should write through Drizzle's `effect-sqlite-node` driver: its queries use the same connection, values are encoded exactly as the mirror decodes them, and `db.transaction` nests with `mirror.write` in either direction.

## Testing

`@muswag/tanstack-db-mirror/testing` provides `createMemoryTransport()`. It's an in-process transport with IPC-like behavior: structured cloning, FIFO requests and batches, latency you can configure, and the ability to pause or drop batches.

The package's own suite covers the following:

- **Change capture:** every SQL write path, and memory writes, rollbacks and nesting.
- **Request handling:** request validation and atomic mutations, for both servers.
- **Stream recovery:** gaps, pruning, the heartbeat and server restarts.
- **Optimistic updates:** no flicker while a mutation round-trips.
- **Mixed sources:** a live query joining a memory table with a SQLite one.
- **Electron transports:** tested over a fake IPC bus.
- **Seeded fuzz tests, one per server:** concurrent server writes, client mutations, dropped batches, reloads and restarts across three clients. To soak locally, run `MIRROR_FUZZ_SEEDS=40 MIRROR_FUZZ_STEPS=600 pnpm test`.
