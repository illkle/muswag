import type { SearchHit } from "@muswag/model";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { createSearchIndex } from "./search-index.ts";
import { SEARCHED_COLUMNS, type SearchedChange, type SearchedLibrary, type SearchedRow, type SearchWorkerChange } from "./searched-fields.ts";

/** What main sends the worker. */
export type SearchWorkerRequest =
  | { readonly type: "changed"; readonly changes: ReadonlyArray<SearchWorkerChange> }
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

const selectFrom = (table: keyof SearchedLibrary) => `SELECT ${["id", ...SEARCHED_COLUMNS[table]].map((column) => `"${column}"`).join(", ")} FROM "${table}"`;
const readAll = (table: keyof SearchedLibrary) => database.prepare(selectFrom(table)).all() as unknown as SearchedRow[];
const readIds = (table: keyof SearchedLibrary, ids: ReadonlyArray<string>) =>
  database.prepare(`${selectFrom(table)} WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as unknown as SearchedRow[];

/**
 * The changes as the index takes them. Those that carry only an id, as songs' and albums' do, are
 * read here as the rows are now, which is after main committed them; a row that has gone since is a
 * delete.
 */
const withRows = (changes: ReadonlyArray<SearchWorkerChange>): SearchedChange[] => {
  const written = new Map<keyof SearchedLibrary, Set<string>>();
  const result: SearchedChange[] = [];
  for (const change of changes) {
    if (change.type !== "changed") result.push(change);
    else {
      const table = change.table as keyof SearchedLibrary;
      written.set(table, (written.get(table) ?? new Set()).add(change.key));
    }
  }
  for (const [table, ids] of written) {
    const rows = new Map(readIds(table, [...ids]).map((row) => [row.id, row]));
    for (const id of ids) {
      const value = rows.get(id);
      result.push(value ? { table, type: "upsert", value } : { table, type: "delete", key: id });
    }
  }
  return result;
};

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
  if (request.type === "changed") return index.changed(withRows(request.changes));
  try {
    port.postMessage({ id: request.id, ok: true, hits: index.search(request.query, request.limit) } satisfies SearchWorkerReply);
  } catch (cause) {
    port.postMessage({ id: request.id, ok: false, message: cause instanceof Error ? cause.message : String(cause) } satisfies SearchWorkerReply);
  }
});

// Built ahead of the first search, which then only searches.
index.prepare();
