import BetterSqlite3 from "better-sqlite3-test";
import { createNodeSQLitePersistence } from "@tanstack/node-db-sqlite-persistence";

import { createMuswagDb, type MuswagDb } from "#core";

export function createInMemoryDb(): MuswagDb {
  const sqlite = new BetterSqlite3(":memory:");
  const persistence = createNodeSQLitePersistence({ database: sqlite });
  return createMuswagDb(persistence);
}
