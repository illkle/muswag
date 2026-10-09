import { getColumns, type InferSelectModel } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

import { titleSortKey } from "../library-order.js";
import { songs, type Song } from "./schema.js";

/**
 * Builds a complete row of `table` from an object keyed like it, such as a Subsonic API object:
 * missing fields become `null` and fields the table has no column for are dropped.
 */
export function toRow<TTable extends SQLiteTable>(table: TTable, value: object): InferSelectModel<TTable> {
  const source = value as Record<string, unknown>;
  const row: Record<string, unknown> = {};
  for (const key of Object.keys(getColumns(table))) row[key] = source[key] ?? null;
  return row as InferSelectModel<TTable>;
}

/** A complete song row from an object keyed like the table, with what the row is sorted by made from it. */
export const toSongRow = (value: { title: string }): Song => ({ ...toRow(songs, value), titleSortKey: titleSortKey(value.title) });

/** A song row with only the given fields set. */
export const songRow = (fields: Pick<Song, "id" | "title"> & Partial<Song>): Song => toSongRow({ isDir: false, ...fields });
