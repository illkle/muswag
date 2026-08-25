import BetterSqlite3 from "better-sqlite3-test";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import { createMuswagDb, type MuswagDb } from "../db/database.js";

export function createInMemoryDb(): MuswagDb {
  const sqlite = new BetterSqlite3(":memory:");
  return createMuswagDb(createNodeSQLitePersistence({ database: sqlite }));
}
