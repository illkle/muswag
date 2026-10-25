import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { deserialize, serialize } from "node:v8";

import { DatabaseLive, LibraryChanges } from "@muswag/backend";
import { Effect, type Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { libraryWithSongs } from "./library-fixture.js";

/** The library sizes to measure, from `MUSWAG_BENCH_SIZES` (comma-separated). */
export const SIZES = (process.env.MUSWAG_BENCH_SIZES ?? "4358,25000,100000,250000").split(",").map(Number);

export type TransportStats = { requests: number; bytes: number; serverMs: number; serializeMs: number; deserializeMs: number };

/**
 * A library of `songCount` songs served by the app's own database layer, with what main's reads
 * return copied the way Electron's IPC copies it: serialized by V8 on one side, deserialized on the other.
 */
export async function openLibrary(songCount: number) {
  const dir = join(tmpdir(), "muswag-songs-benchmark", "runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${process.pid}-${songCount}.db`);
  copyFileSync(libraryWithSongs(songCount), file);

  const runtime = ManagedRuntime.make(DatabaseLive(file));
  const changes = await runtime.runPromise(Effect.service(LibraryChanges));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));

  const stats: TransportStats = { requests: 0, bytes: 0, serverMs: 0, serializeMs: 0, deserializeMs: 0 };
  const resetStats = () => Object.assign(stats, { requests: 0, bytes: 0, serverMs: 0, serializeMs: 0, deserializeMs: 0 });

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

  /** Runs `statement` through `LibraryChanges.write`, so its changes are announced the way the app's are. */
  const exec = (statement: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(changes.write(sql.unsafe(statement, params)));
  const query = <Row extends object>(statement: string, params: ReadonlyArray<unknown> = []) => runtime.runPromise(sql.unsafe<Row>(statement, params));
  /** Runs one of main's own reads, such as `LibraryQueries.songPage`, counting it as a request. */
  const run = async <A, E>(effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof DatabaseLive>>>) => {
    stats.requests++;
    const started = performance.now();
    const result = await runtime.runPromise(effect);
    stats.serverMs += performance.now() - started;
    return result;
  };

  const dispose = async () => {
    await runtime.dispose();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  };

  return { file, runtime, changes, stats, resetStats, copy, exec, query, run, dispose };
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
