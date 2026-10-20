import { Worker } from "node:worker_threads";

import type { SearchHit } from "@muswag/model";
import type { MirrorChangeBatch } from "@muswag/tanstack-db-mirror/protocol";

import { SEARCHED_COLUMNS, SEARCHED_TABLES, type SearchedLibrary, type SearchedRow, type SearchWorkerChange } from "./searched-fields";
import type { SearchWorkerData, SearchWorkerReply, SearchWorkerRequest } from "./search-worker";

export interface LibrarySearchOptions {
  readonly databasePath: string;
  /** The worker's script: `search-worker.ts`, as built next to main's. */
  readonly workerPath: string;
  /** Hears every change to the library, as the mirror sends it to renderers. */
  readonly subscribe: (listener: (batch: MirrorChangeBatch) => void) => () => void;
}

type Search = { readonly query: string; readonly limit: number; readonly resolve: (hits: SearchHit[] | null) => void; readonly reject: (cause: unknown) => void };

/**
 * The fields of a change that the index looks at, or nothing for a change to another table. A change
 * of a song or an album carries only its id, which goes to the worker as it is: the worker reads the row.
 */
const searchedChange = (change: MirrorChangeBatch["changes"][number]): SearchWorkerChange[] => {
  if (!SEARCHED_TABLES.has(change.table)) return [];
  if (change.type !== "upsert") return [{ table: change.table, type: change.type, key: String(change.key) }];
  const columns = SEARCHED_COLUMNS[change.table as keyof SearchedLibrary];
  const value = Object.fromEntries(["id", ...columns].map((column) => [column, change.value[column]])) as SearchedRow;
  return [{ table: change.table, type: "upsert", value }];
};

/**
 * The library's search, which runs in a worker (`search-worker.ts`) and answers here.
 *
 * A search cannot be stopped once it runs, so one runs at a time: one asked for meanwhile waits, and
 * replaces any that was waiting before it, which is answered with `null`. Typing faster than the
 * searches finish skips to what is in the field rather than working through every key.
 */
export function startLibrarySearch(options: LibrarySearchOptions) {
  let worker: Worker | undefined;
  let nextId = 0;
  let running: (Search & { readonly id: number }) | undefined;
  let waiting: Search | undefined;

  const failRunning = (cause: unknown) => {
    running?.reject(cause);
    running = undefined;
  };

  /** The worker, started again after it has failed. */
  const ensureWorker = () => {
    if (worker) return worker;
    const started = new Worker(options.workerPath, { workerData: { databasePath: options.databasePath } satisfies SearchWorkerData });
    started.on("message", (reply: SearchWorkerReply) => {
      if (reply.id !== running?.id) return;
      if (reply.ok) running.resolve([...reply.hits]);
      else running.reject(new Error(reply.message));
      running = undefined;
      runNext();
    });
    started.on("error", (cause) => console.error("[search] the worker failed", cause));
    started.on("exit", () => {
      if (worker !== started) return;
      worker = undefined;
      failRunning(new Error("The search stopped"));
      runNext();
    });
    worker = started;
    return started;
  };

  const runNext = () => {
    if (running || !waiting) return;
    const search = waiting;
    waiting = undefined;
    running = { ...search, id: nextId++ };
    ensureWorker().postMessage({ type: "search", id: running.id, query: search.query, limit: search.limit } satisfies SearchWorkerRequest);
  };

  const unsubscribe = options.subscribe((batch) => {
    const changes = batch.changes.flatMap(searchedChange);
    if (changes.length) worker?.postMessage({ type: "changed", changes } satisfies SearchWorkerRequest);
  });

  ensureWorker();

  return {
    /** The best matches for `query`, best first, or `null` when a later search took its place before it ran. */
    search(query: string, limit: number): Promise<SearchHit[] | null> {
      return new Promise((resolve, reject) => {
        waiting?.resolve(null);
        waiting = { query, limit, resolve, reject };
        runNext();
      });
    },

    async dispose() {
      unsubscribe();
      waiting?.resolve(null);
      waiting = undefined;
      const stopping = worker;
      worker = undefined;
      failRunning(new Error("The search stopped"));
      await stopping?.terminate();
    },
  };
}

export type LibrarySearch = ReturnType<typeof startLibrarySearch>;
