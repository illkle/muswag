import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Database } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import { app } from "electron";
import { schema, DRIZZLE_MIGRATIONS_PATH } from "@muswag/shared";
import { BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export type DB_E = BetterSQLite3Database<typeof schema>;

let sqlite: Database | undefined;
let db: DB_E | undefined;

function getDatabasePath(): string {
  return join(app.getPath("userData"), "muswag.db");
}

function getDatabase(): Database {
  if (sqlite) {
    return sqlite;
  }

  const databasePath = getDatabasePath();
  console.log("db path", databasePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  sqlite = new BetterSqlite3(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  return sqlite;
}

export function getDrizzleDb() {
  if (db) {
    return db;
  }

  db = drizzle(getDatabase(), { schema });
  migrate(db, { migrationsFolder: DRIZZLE_MIGRATIONS_PATH });

  return db;
}

export function closeDb() {
  sqlite?.close();
}
