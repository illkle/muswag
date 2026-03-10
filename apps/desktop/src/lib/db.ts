import { SyncManager, createDrizzleDb } from "@muswag/db";
import Database from "@tauri-apps/plugin-sql";
import type { RemoteCallback } from "drizzle-orm/sqlite-proxy";

function isSelectQuery(sql: string): boolean {
  const selectRegex = /^\s*SELECT\b/i;
  return selectRegex.test(sql);
}

const sqlitePromise = Database.load("sqlite:muswag.db");

// https://github.com/tdwesten/tauri-drizzle-sqlite-proxy-demo/blob/main/src/db/database.ts
export function withBetterSqlite(): RemoteCallback {
  return async (sql, params, method) => {
    const sqlite = await sqlitePromise;
    let rows: any = [];
    let results = [];

    // If the query is a SELECT, use the select method
    if (isSelectQuery(sql)) {
      rows = await sqlite.select(sql, params).catch((e) => {
        console.error("SQL Error:", e);
        return [];
      });
    } else {
      // Otherwise, use the execute method
      rows = await sqlite.execute(sql, params).catch((e) => {
        console.error("SQL Error:", e);
        return [];
      });
      return { rows: [] };
    }

    rows = rows.map((row: any) => {
      return Object.values(row);
    });

    // If the method is "all", return all rows
    results = method === "all" ? rows : rows[0];
    return { rows: results };
  };
}

export const db = createDrizzleDb(withBetterSqlite());

export const SM = new SyncManager(db);
