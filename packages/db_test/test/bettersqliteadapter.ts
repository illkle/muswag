import { performance } from "node:perf_hooks";

import type { Database } from "better-sqlite3";
import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";

type ProxyMethod = Parameters<RemoteCallback>[2];
type ProxyResult = Awaited<ReturnType<RemoteCallback>>;

export interface SqliteQueryProfilerSnapshot {
  allCount: number;
  allTimeMs: number;
  getCount: number;
  getTimeMs: number;
  runCount: number;
  runTimeMs: number;
  totalCount: number;
  totalTimeMs: number;
  valuesCount: number;
  valuesTimeMs: number;
}

export interface SqliteQueryProfiler extends SqliteQueryProfilerSnapshot {
  reset: () => void;
}

function createEmptySnapshot(): SqliteQueryProfilerSnapshot {
  return {
    allCount: 0,
    allTimeMs: 0,
    getCount: 0,
    getTimeMs: 0,
    runCount: 0,
    runTimeMs: 0,
    totalCount: 0,
    totalTimeMs: 0,
    valuesCount: 0,
    valuesTimeMs: 0,
  };
}

export function createSqliteQueryProfiler(): SqliteQueryProfiler {
  const profiler: SqliteQueryProfiler = {
    ...createEmptySnapshot(),
    reset: () => {
      Object.assign(profiler, createEmptySnapshot());
    },
  };

  return profiler;
}

function assertNever(method: never): never {
  throw new Error(`Unsupported sqlite proxy method: ${String(method)}`);
}

function execute(db: Database, sql: string, params: unknown[], method: ProxyMethod): ProxyResult {
  const statement = db.prepare(sql);

  switch (method) {
    case "run": {
      const runResult = statement.run(...params);
      return {
        rows: [
          {
            changes: runResult.changes,
            lastInsertRowid: runResult.lastInsertRowid,
          },
        ],
      };
    }
    case "all":
      return { rows: statement.raw(true).all(...params) };
    case "values":
      return { rows: statement.raw(true).all(...params) };
    case "get": {
      const row = statement.raw(true).get(...params);
      return { rows: (row ?? undefined) as ProxyResult["rows"] };
    }
    default:
      return assertNever(method);
  }
}

export function withBetterSqlite(db: Database): RemoteCallback {
  return async (sql, params, method) => execute(db, sql, params, method);
}

export function withProfiledBetterSqlite(
  db: Database,
  profiler: SqliteQueryProfiler,
): RemoteCallback {
  return async (sql, params, method) => {
    const startedAt = performance.now();
    try {
      return execute(db, sql, params, method);
    } finally {
      const durationMs = performance.now() - startedAt;
      profiler.totalCount += 1;
      profiler.totalTimeMs += durationMs;

      switch (method) {
        case "all":
          profiler.allCount += 1;
          profiler.allTimeMs += durationMs;
          break;
        case "get":
          profiler.getCount += 1;
          profiler.getTimeMs += durationMs;
          break;
        case "run":
          profiler.runCount += 1;
          profiler.runTimeMs += durationMs;
          break;
        case "values":
          profiler.valuesCount += 1;
          profiler.valuesTimeMs += durationMs;
          break;
        default:
          assertNever(method);
      }
    }
  };
}
