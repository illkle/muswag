import { getColumns, getTableName, type Column, type InferInsertModel, type InferSelectModel } from "drizzle-orm";
import * as SqliteCore from "drizzle-orm/sqlite-core";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";

import type { MirrorKey, MirrorRow } from "./protocol.js";

export type AnyMirrorTable = SQLiteTable;

type TableColumns<TTable extends AnyMirrorTable> = TTable["_"]["columns"];

/** TypeScript key of the table's primary-key column. */
export type MirrorPrimaryKeyName<TTable extends AnyMirrorTable> = {
  [K in keyof TableColumns<TTable>]: TableColumns<TTable>[K] extends Column<infer TConfig> ? (TConfig["isPrimaryKey"] extends true ? K : never) : never;
}[keyof TableColumns<TTable>] &
  string;

export type MirrorRowOf<TTable extends AnyMirrorTable> = InferSelectModel<TTable>;
export type MirrorInsertOf<TTable extends AnyMirrorTable> = InferInsertModel<TTable>;
export type MirrorKeyOf<TTable extends AnyMirrorTable> = Extract<TableColumns<TTable>[MirrorPrimaryKeyName<TTable>]["_"]["data"], MirrorKey>;

export class MirrorSchemaError extends Error {
  override readonly name = "MirrorSchemaError";
}

export type MirrorColumn = {
  /** Property name on the row object. */
  readonly key: string;
  /** Column name in SQLite. */
  readonly name: string;
  readonly column: Column;
};

export type MirrorTableInfo = {
  readonly table: AnyMirrorTable;
  readonly name: string;
  readonly columns: ReadonlyArray<MirrorColumn>;
  readonly columnsByKey: ReadonlyMap<string, MirrorColumn>;
  readonly primaryKey: MirrorColumn;
};

// json_object() takes two arguments per column and SQLite caps function arguments at 127 by default.
const MAX_COLUMNS = 63;
// Types whose values round-trip through json_object() and JSON. Blobs cannot be embedded in JSON,
// and bigint modes would lose precision. Custom columns must not store blobs.
const SUPPORTED_COLUMN_TYPES = new Set([
  "SQLiteText",
  "SQLiteTextJson",
  "SQLiteInteger",
  "SQLiteBoolean",
  "SQLiteTimestamp",
  "SQLiteReal",
  "SQLiteNumeric",
  "SQLiteNumericNumber",
  "SQLiteCustomColumn",
]);

const cache = new WeakMap<AnyMirrorTable, MirrorTableInfo>();

export function describeTable(table: AnyMirrorTable): MirrorTableInfo {
  const cached = cache.get(table);
  if (cached) return cached;

  const name = getTableName(table);
  const config = getTableConfig(table);
  const columns = Object.entries(getColumns(table) as Record<string, Column>).map(([key, column]) => ({ key, name: column.name, column }));

  if (config.primaryKeys.length > 0) {
    throw new MirrorSchemaError(`Table "${name}" uses a composite primary key; mirrored tables need a single primary-key column`);
  }
  const primaryKeys = columns.filter((column) => column.column.primary);
  const primaryKey = primaryKeys[0];
  if (primaryKeys.length !== 1 || !primaryKey) {
    throw new MirrorSchemaError(`Table "${name}" must have exactly one primary-key column`);
  }
  if (columns.length > MAX_COLUMNS) {
    throw new MirrorSchemaError(`Table "${name}" has ${columns.length} columns; at most ${MAX_COLUMNS} are supported`);
  }
  for (const { name: columnName, column } of columns) {
    if (!SUPPORTED_COLUMN_TYPES.has(column.columnType)) {
      throw new MirrorSchemaError(`Column "${name}.${columnName}" has unsupported type ${column.columnType}; blob and bigint columns cannot be mirrored`);
    }
  }

  const info: MirrorTableInfo = {
    table,
    name,
    columns,
    columnsByKey: new Map(columns.map((column) => [column.key, column])),
    primaryKey,
  };
  cache.set(table, info);
  return info;
}

type JsonDecodingColumn = Column & { readonly codec?: string; readonly mapFromJsonValue?: (value: unknown) => unknown };

// From drizzle-orm 1.0.0-rc.5 on, built-in column types decode through per-type codecs instead of
// their own mapFromDriverValue. Earlier versions don't export these.
const jsonCodecs = (SqliteCore as { genericSQLiteCodecs?: Record<string, { normalizeInJson?: (value: unknown) => unknown } | undefined> }).genericSQLiteCodecs;

/** Decodes a column value read from `json_object(...)`, the way Drizzle decodes relational query results. */
export function decodeValue(column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const jsonColumn = column as JsonDecodingColumn;
  if (jsonColumn.mapFromJsonValue) return jsonColumn.mapFromJsonValue(value);
  const normalize = jsonColumn.codec === undefined ? undefined : jsonCodecs?.[jsonColumn.codec]?.normalizeInJson;
  return column.mapFromDriverValue(normalize ? normalize(value) : value);
}

export function encodeValue(column: Column, value: unknown): unknown {
  return value === null || value === undefined ? null : column.mapToDriverValue(value);
}

/** Decodes the `json_object(...)` text produced by the capture triggers and snapshot queries. */
export function decodeRow(info: MirrorTableInfo, json: string): MirrorRow {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const row: MirrorRow = {};
  for (const { key, name, column } of info.columns) {
    row[key] = decodeValue(column, raw[name]);
  }
  return row;
}
