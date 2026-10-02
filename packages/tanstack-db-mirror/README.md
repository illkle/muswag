# @muswag/tanstack-db-mirror

TanStack DB collections that mirror SQLite tables owned by another process. In Electron, the main process owns the database and the renderer gets live, optimistic collections on top of it.

- **SQLite is the source of truth.** Triggers capture every write to a mirrored table, including bulk `UPDATE … WHERE`, foreign-key cascades and `REPLACE` conflicts. The changes are pushed to every connected renderer.
- **Renderer mutations are optimistic.** `collection.insert/update/delete` writes to SQLite through the main process. It resolves once the resulting change has come back through the stream, so the optimistic state is replaced by synced state in one step, without flicker.
- **One schema.** Tables are Drizzle `sqliteTable` definitions. Row and key types come from them, and values are encoded and decoded with Drizzle's column codecs: booleans, timestamps and JSON columns arrive as JS values.

## How it works

```
 main process (MirrorServer)                          renderer (MirrorClient + collections)
 ┌──────────────────────────────┐   hello/snapshot/   ┌──────────────────────────────┐
 │ tables ──triggers──► change  │◄── mutate/pull ─────│ mirrorCollectionOptions(...) │
 │                      log     │                     │   eager snapshot, then       │
 │ write(effect) ─commit─► flush├──── change batch ──►│   apply ordered change batch │
 └──────────────────────────────┘                     └──────────────────────────────┘
```

- **Change capture.** Each mirrored table gets `AFTER INSERT/UPDATE/DELETE` triggers. They append the row to `__mirror_changes` as `json_object(...)`, under an `AUTOINCREMENT` sequence number (`seq`).
- **Broadcast.** `MirrorServer.write(effect)` runs the effect in a transaction. After it commits, it broadcasts every change logged since the last broadcast as one batch covering `(fromSeq, toSeq]`.
- **Gap recovery.** The client tracks the last contiguous `seq` it has delivered. If a batch starts after that point, it pulls the missing range. If that range has been pruned, every collection reloads.
- **Restarts.** Each server start takes a new `epoch`, seeded from the clock so that a replaced database file still moves forward. Clients reload when they see a newer epoch. A lower one is usually a replaced server answering late; the client checks with `hello` and only reconnects if that server is actually the live one.
- **Loading.** A collection subscribes to the stream, takes a snapshot of its table at a known `seq`, then applies only the changes after it. Collections are eager: the whole table is held in memory.
- **Mutations.** A mutation is applied in one SQLite transaction. The server returns the resulting position, and the handler waits until the collection has synced up to it. If the stream hasn't caught up shortly afterwards, the client pulls the missing range, so a lost batch is recovered even when no later batch arrives.
- **After a commit, a write has succeeded.** If broadcasting fails, the error is logged and the next flush retries. A captured change that can't be decoded is logged and skipped, so it doesn't block later changes.

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

Main process. The tables must exist before the server starts, so run migrations first. The server lives as long as its scope, so provide it as a layer:

```ts
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { MirrorServer } from "@muswag/tanstack-db-mirror/server";
import { createElectronMainTransport } from "@muswag/tanstack-db-mirror/electron/main";
import { eq } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { ipcMain } from "electron";
import { Effect, Layer, ManagedRuntime } from "effect";

const MirrorLive = Layer.effect(
  MirrorServer,
  Effect.gen(function* () {
    const mirror = yield* MirrorServer.make({ tables: [albums] });
    yield* mirror.serve(createElectronMainTransport({ ipcMain }));
    return mirror;
  }),
);
const runtime = ManagedRuntime.make(MirrorLive.pipe(Layer.provideMerge(Migrations), Layer.provideMerge(SqliteClient.layer({ filename: dbPath }))));

// Everything inside `write` commits together and is broadcast after the commit.
const starAlbum = (id: string) =>
  Effect.gen(function* () {
    const mirror = yield* MirrorServer;
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

### Read-only mirrors

If every change should go through your own main-process commands, turn off renderer writes on both sides. The server then rejects `mutate` requests, so a renderer can't write to mirrored tables even if its code is compromised. The collections leave out their mutation handlers, so `insert`, `update` and `delete` throw in the renderer instead of reaching SQLite. Commands return a position for `awaitPosition` as above.

```ts
MirrorServer.make({ tables: [albums, songs], readOnly: true }); // main
mirrorCollectionOptions({ client, table: albums, readOnly: true }); // renderer
```

## Rules and limits

- **Write through `mirror.write`.** Writes made any other way are still captured, but they aren't broadcast until the next `write` or `mirror.flush`. `autoFlushInterval` adds a periodic backstop.
- **Primary keys:** single-column only. A primary-key change is mirrored as a delete followed by an insert.
- **Supported columns:** text, JSON text, integer, boolean, timestamp, real and numeric (string or number mode). Custom column types are allowed but must not store blobs. Blob and bigint columns are rejected at startup. At most 63 columns per table, because of SQLite's limit on function arguments.
- **Integers** must stay within `Number.MAX_SAFE_INTEGER`. Larger keys are skipped with an error log, and larger values in other columns are rounded.
- **Column names** come from the Drizzle table definition. Drizzle's database-level `casing` option is not applied, so name columns explicitly instead of relying on it.
- **Runtime defaults:** `$defaultFn` and `$onUpdateFn` are applied to mutations from the renderer. Defaults written as SQL expressions are not.
- **One connection.** The server relies on Effect's single-connection SQLite client: it turns on `PRAGMA recursive_triggers` (so rows removed by `REPLACE` produce delete events), and it detects open transactions through `sql.withTransaction`. Raw `BEGIN` statements, other connections and other processes writing the same file aren't covered. `recursive_triggers` also applies to your own triggers on that connection.
- **Schema changes:** triggers are rebuilt from the table definitions at every start, so migrations don't need to know about them. Exclude `__mirror_changes` and `__mirror_changes_meta` from drizzle-kit (`tablesFilter`). Capture triggers are named `__mirror_changes__<table>_<op>`; only those are dropped on restart.
- **Electron renderer transport:** pass an `ipcRenderer` whose `on` returns an unsubscribe function, such as the one `@electron-toolkit/preload` exposes. With the raw `ipcRenderer` behind `contextBridge`, `removeListener` can't match the proxied listener, so the listener leaks when the client is disposed.
- **Drizzle:** the server reads table metadata and value codecs from Drizzle and runs its own SQL through Effect's `SqlClient`. It is built against `drizzle-orm@1.0.0-rc.5` (a nightly; `rc.4`'s Effect driver does not run on `effect@4.0.0`), which decodes values through per-type codecs, so upgrades should be deliberate pin bumps. Application code should write through Drizzle's `effect-sqlite-node` driver: its queries use the same connection, values are encoded exactly as the mirror decodes them, and `db.transaction` nests with `mirror.write` in either direction.

## Testing

`@muswag/tanstack-db-mirror/testing` provides `createMemoryTransport()`. It's an in-process transport with IPC-like behavior: structured cloning, FIFO requests and batches, latency you can configure, and the ability to pause or drop batches.

The package's own suite covers the following:

- **Change capture:** every SQL write path.
- **Request handling:** request validation and atomic mutations.
- **Stream recovery:** gaps, pruning and server restarts.
- **Optimistic updates:** no flicker while a mutation round-trips.
- **Electron transports:** tested over a fake IPC bus.
- **A seeded fuzz test:** concurrent server writes, client mutations, dropped batches, reloads and restarts across three clients. To soak locally, run `MIRROR_FUZZ_SEEDS=40 MIRROR_FUZZ_STEPS=600 pnpm test`.
