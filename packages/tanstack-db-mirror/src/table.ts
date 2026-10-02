import { describeTable, type SqliteInsertOf, type SqliteKeyOf, type SqliteMirrorTable, type SqliteRowOf } from "./drizzle.js";
import type { MirrorKey, MirrorRow } from "./protocol.js";

export const MemoryTableTypeId: unique symbol = Symbol.for("@muswag/tanstack-db-mirror/MemoryTable");

/**
 * A table a `MemoryMirror` keeps in memory. Its rows cross processes in their encoded form and are
 * decoded on arrival. Create one with `memoryTable` from `@muswag/tanstack-db-mirror/memory`.
 */
export interface MemoryTable<Row extends object, Key extends MirrorKey> {
  readonly [MemoryTableTypeId]: true;
  readonly name: string;
  /** Property of the row that identifies it. */
  readonly primaryKey: string;
  readonly keyOf: (row: Row) => Key;
  /** Throws when `row` does not satisfy the table's schema. */
  readonly encode: (row: Row) => MirrorRow;
  /** Throws when `encoded` does not satisfy the table's schema. */
  readonly decode: (encoded: unknown) => Row;
}
export type AnyMemoryTable = MemoryTable<any, any>;

export const isMemoryTable = (table: unknown): table is AnyMemoryTable => typeof table === "object" && table !== null && MemoryTableTypeId in table;

/** A Drizzle SQLite table served by a `SqliteMirror`, or a memory table served by a `MemoryMirror`. */
export type AnyMirrorTable = SqliteMirrorTable | AnyMemoryTable;

export type MirrorRowOf<TTable extends AnyMirrorTable> = TTable extends MemoryTable<infer Row, any> ? Row : TTable extends SqliteMirrorTable ? SqliteRowOf<TTable> : never;
export type MirrorKeyOf<TTable extends AnyMirrorTable> = TTable extends MemoryTable<any, infer Key> ? Key : TTable extends SqliteMirrorTable ? SqliteKeyOf<TTable> : never;
export type MirrorInsertOf<TTable extends AnyMirrorTable> = TTable extends MemoryTable<infer Row, any> ? Row : TTable extends SqliteMirrorTable ? SqliteInsertOf<TTable> : never;

/** What a client needs to know about a mirrored table, whatever stores it. */
export interface MirrorTableAccess {
  readonly name: string;
  readonly primaryKey: string;
  /** Turns a row as it arrives into the collection's value. SQLite rows arrive decoded already. */
  readonly decode: ((value: unknown) => MirrorRow) | null;
  /** Turns a collection value into what the server accepts in a mutation. */
  readonly encode: ((row: MirrorRow) => MirrorRow) | null;
}

export function tableAccess(table: AnyMirrorTable): MirrorTableAccess {
  if (isMemoryTable(table)) {
    return { name: table.name, primaryKey: table.primaryKey, decode: (value) => table.decode(value) as MirrorRow, encode: (row) => table.encode(row) };
  }
  const info = describeTable(table);
  return { name: info.name, primaryKey: info.primaryKey.key, decode: null, encode: null };
}
