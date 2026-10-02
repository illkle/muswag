import { getColumns, sql, type InferSelectModel, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/** Rows per multi-row statement, comfortably below SQLite's bound-parameter limit for wide tables. */
export const STATEMENT_ROWS = 200;
/** Ids per `IN (...)` list. */
export const STATEMENT_IDS = 500;

/** `ON CONFLICT DO UPDATE` assignments that take every column but `keep` from the incoming row. */
export function excludedSet<TTable extends SQLiteTable>(table: TTable, keep: ReadonlyArray<keyof InferSelectModel<TTable>> = []): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [key, column] of Object.entries(getColumns(table))) {
    if (column.primary || keep.includes(key as keyof InferSelectModel<TTable>)) continue;
    set[key] = sql.raw(`excluded."${column.name.replaceAll('"', '""')}"`);
  }
  return set;
}

export function chunks<T>(items: ReadonlyArray<T>, size: number): Array<ReadonlyArray<T>> {
  const result: Array<ReadonlyArray<T>> = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}
