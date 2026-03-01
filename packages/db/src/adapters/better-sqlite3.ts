import Database from "better-sqlite3";

import type { DbAdapter } from "../public-api.js";

class BetterSqliteAdapter implements DbAdapter {
  private readonly db: Database.Database;
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.pragma("journal_mode = WAL");
  }

  async exec(sql: string, params: readonly unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async queryOne<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    const isTopLevel = this.transactionDepth === 0;
    const savepointName = `sp_${++this.savepointCounter}`;

    if (isTopLevel) {
      this.db.prepare("BEGIN").run();
    } else {
      this.db.prepare(`SAVEPOINT ${savepointName}`).run();
    }

    this.transactionDepth += 1;

    try {
      const result = await fn(this);
      this.transactionDepth -= 1;

      if (isTopLevel) {
        this.db.prepare("COMMIT").run();
      } else {
        this.db.prepare(`RELEASE SAVEPOINT ${savepointName}`).run();
      }

      return result;
    } catch (error) {
      this.transactionDepth -= 1;

      if (isTopLevel) {
        this.db.prepare("ROLLBACK").run();
      } else {
        this.db.prepare(`ROLLBACK TO SAVEPOINT ${savepointName}`).run();
        this.db.prepare(`RELEASE SAVEPOINT ${savepointName}`).run();
      }

      throw error;
    }
  }
}

export function createBetterSqliteAdapter(filename: string): DbAdapter {
  return new BetterSqliteAdapter(new Database(filename));
}
