import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { deserialize, serialize } from "node:v8";

import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { DatabaseLive } from "@muswag/backend";
import { MIRROR_OMITTED_COLUMNS, MIRRORED_TABLES } from "@muswag/model";
import type { MirrorChangeBatch, MirrorClientTransport, MirrorResponse } from "@muswag/tanstack-db-mirror/protocol";
import { createMirrorClient, type MirrorClient } from "@muswag/tanstack-db-mirror/client";
import { SqliteMirror } from "@muswag/tanstack-db-mirror/server/sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { libraryWithSongs } from "./library-fixture.js";

/** The library sizes to measure, from `MUSWAG_BENCH_SIZES` (comma-separated). */
export const SIZES = (process.env.MUSWAG_BENCH_SIZES ?? "4358,25000,100000,250000").split(",").map(Number);

/** Added to every request and every pushed batch, standing in for the hop between processes. */
const LATENCY_MS = Number(process.env.MUSWAG_BENCH_LATENCY_MS ?? 0);

export type TransportStats = { requests: number; bytes: number; serverMs: number; serializeMs: number; deserializeMs: number };

/**
 * A library of `songCount` songs served by the app's own database layer and mirror server, and a
 * mirror client connected to it through a transport that copies every message the way Electron's IPC
 * does: serialized by V8 on one side, deserialized on the other.
 *
 * With `fullRows` the mirror sends songs whole in its change stream, as it did before songs were
 * key-only; the library is migrated by the app's layer first, and then has no `Db` to run queries with.
 */
export async function openLibrary(songCount: number, options: { readonly fullRows?: boolean } = {}) {
  const dir = join(tmpdir(), "muswag-songs-benchmark", "runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${process.pid}-${songCount}.db`);
  copyFileSync(libraryWithSongs(songCount), file);

  if (options.fullRows) await ManagedRuntime.make(DatabaseLive(file)).dispose();
  const layer = options.fullRows
    ? SqliteMirror.layer({ tables: MIRRORED_TABLES, omitColumns: MIRROR_OMITTED_COLUMNS }).pipe(Layer.provideMerge(SqliteClient.layer({ filename: file })))
    : DatabaseLive(file);
  const runtime = ManagedRuntime.make(layer as ReturnType<typeof DatabaseLive>);
  const mirror = await runtime.runPromise(Effect.service(SqliteMirror));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));

  const stats: TransportStats = { requests: 0, bytes: 0, serverMs: 0, serializeMs: 0, deserializeMs: 0 };
  const resetStats = () => Object.assign(stats, { requests: 0, bytes: 0, serverMs: 0, serializeMs: 0, deserializeMs: 0 });
  const delay = () => (LATENCY_MS > 0 ? new Promise<void>((resolve) => setTimeout(resolve, LATENCY_MS)) : Promise.resolve());

  const copy = <T>(value: T): T => {
    const started = performance.now();
    const bytes = serialize(value);
    const serialized = performance.now();
    const result = deserialize(bytes) as T;
    stats.serializeMs += serialized - started;
    stats.deserializeMs += performance.now() - serialized;
    stats.bytes += bytes.byteLength;
    return result;
  };

  const transport: MirrorClientTransport = {
    request: async (request) => {
      await delay();
      stats.requests++;
      const started = performance.now();
      const response = await runtime.runPromise(mirror.handle(copy(request)));
      stats.serverMs += performance.now() - started;
      await delay();
      return copy(response) as MirrorResponse<typeof request.type>;
    },
    subscribe: (listener) =>
      mirror.subscribe((batch) => {
        void delay().then(() => listener(copy(batch) as MirrorChangeBatch));
      }),
  };
  const client: MirrorClient = createMirrorClient({ transport, heartbeatMs: 0, requestTimeoutMs: 10 * 60_000 });

  /** Runs `statement` through the mirror's `write`, so its changes are pushed the way the app's are. */
  const exec = (statement: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(mirror.write(sql.unsafe(statement, params)));
  const query = <Row extends object>(statement: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(sql.unsafe<Row>(statement, params));
  /** Runs one of main's own reads, such as `LibraryQueries.songPage`. */
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof DatabaseLive>>>) => runtime.runPromise(effect);

  const dispose = async () => {
    client.dispose();
    await runtime.dispose();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  };

  return { file, runtime, mirror, client, transport, stats, resetStats, copy, exec, query, run, dispose };
}

export type Library = Awaited<ReturnType<typeof openLibrary>>;

/** Milliseconds `run` takes. */
export async function time(run: () => unknown): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

export const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const collect = () => {
  for (let i = 0; i < 3; i++) globalThis.gc?.();
};

/** The JS heap in use after garbage collection, in MB. */
export function heapMb(): number {
  if (!globalThis.gc) throw new Error("Run with --expose-gc");
  collect();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Resolves once `predicate` holds, checked after every change of `collection`. */
export function waitFor(collection: { subscribeChanges: (listener: () => void) => { unsubscribe: () => void } }, predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.unsubscribe();
      reject(new Error("Timed out waiting for the collection"));
    }, timeoutMs);
    const subscription = collection.subscribeChanges(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      subscription.unsubscribe();
      resolve();
    });
  });
}

export type Result = { readonly option: string; readonly songs: number; readonly metric: string; readonly value: number; readonly unit: string };

/** Collects a file's results, prints them as a table and writes them next to the fixtures. */
export function recorder(option: string) {
  const results: Array<Result> = [];
  return {
    record: (songs: number, metric: string, value: number, unit = "ms") => {
      results.push({ option, songs, metric, value, unit });
      console.info(`[${option}] ${songs} songs · ${metric}: ${value.toFixed(unit === "ms" ? 1 : 2)} ${unit}`);
    },
    save: () => {
      const dir = process.env.MUSWAG_BENCH_OUT ?? join(tmpdir(), "muswag-songs-benchmark", "results");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${option}.json`), JSON.stringify(results, null, 2));
      console.info(table(results));
    },
  };
}

function table(results: ReadonlyArray<Result>): string {
  const sizes = [...new Set(results.map(({ songs }) => songs))];
  const metrics = [...new Set(results.map(({ metric }) => metric))];
  const cell = (metric: string, songs: number) => {
    const result = results.find((entry) => entry.metric === metric && entry.songs === songs);
    return result ? `${result.value.toFixed(result.unit === "ms" ? 1 : 2)} ${result.unit}` : "";
  };
  return [
    `| ${results[0]?.option ?? ""} | ${sizes.join(" | ")} |`,
    `|---|${sizes.map(() => "---").join("|")}|`,
    ...metrics.map((metric) => `| ${metric} | ${sizes.map((songs) => cell(metric, songs)).join(" | ")} |`),
  ].join("\n");
}
