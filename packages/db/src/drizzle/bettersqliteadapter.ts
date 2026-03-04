import type { Database } from "better-sqlite3";
import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";

type ProxyMethod = Parameters<RemoteCallback>[2];
type ProxyResult = Awaited<ReturnType<RemoteCallback>>;

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
