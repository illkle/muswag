import type { SearchHit } from "@muswag/model";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { createSearchIndex } from "./search-index.ts";
import { SEARCHED_COLUMNS, type SearchedChange, type SearchedLibrary, type SearchedRow } from "./searched-fields.ts";

/** What main sends the worker. */
export type SearchWorkerRequest =
  | { readonly type: "changed"; readonly changes: ReadonlyArray<SearchedChange> }
  | { readonly type: "search"; readonly id: number; readonly query: string; readonly limit: number };

/** What the worker answers a search with. */
export type SearchWorkerReply = { readonly id: number; readonly ok: true; readonly hits: ReadonlyArray<SearchHit> } | { readonly id: number; readonly ok: false; readonly message: string };

export type SearchWorkerData = { readonly databasePath: string };

/**
 * The search index, in a thread of its own: a search takes from milliseconds to hundreds of them as
 * the library grows, and on main's thread it would hold up every window's input and IPC meanwhile.
 * It reads the library through a connection of its own, which WAL lets read beside main's writes, so
 * main never reads the whole library for it.
 */
const { databasePath } = workerData as SearchWorkerData;
const database = new DatabaseSync(databasePath, { readOnly: true });
const port = parentPort!;

const readAll = (table: keyof SearchedLibrary) =>
  database.prepare(`SELECT ${["id", ...SEARCHED_COLUMNS[table]].map((column) => `"${column}"`).join(", ")} FROM "${table}"`).all() as unknown as SearchedRow[];

// The three reads are one transaction, so they see the library as it was at one moment.
const read = (): SearchedLibrary => {
  database.exec("BEGIN");
  try {
    return { albums: readAll("albums"), artists: readAll("artists"), songs: readAll("songs") };
  } finally {
    database.exec("COMMIT");
  }
};

const index = createSearchIndex(read);

port.on("message", (request: SearchWorkerRequest) => {
  if (request.type === "changed") return index.changed(request.changes);
  try {
    port.postMessage({ id: request.id, ok: true, hits: index.search(request.query, request.limit) } satisfies SearchWorkerReply);
  } catch (cause) {
    port.postMessage({ id: request.id, ok: false, message: cause instanceof Error ? cause.message : String(cause) } satisfies SearchWorkerReply);
  }
});

// Built ahead of the first search, which then only searches.
index.prepare();
