import { SyncManager, createDrizzleDb } from "@muswag/db";
import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";

export function withBetterSqlite(): RemoteCallback {
  return (sql, params, method) =>
    window.api.querySqlite({ sql, params, method }) as ReturnType<RemoteCallback>;
}

export const db = createDrizzleDb(withBetterSqlite());

export const SM = new SyncManager(db);
