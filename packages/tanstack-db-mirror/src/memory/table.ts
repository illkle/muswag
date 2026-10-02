import { Schema } from "effect";

import type { MirrorKey, MirrorRow } from "../protocol.js";
import { MemoryTableTypeId, type MemoryTable } from "../table.js";

/** Properties of `Row` whose values can identify it. */
export type MemoryKeyProperty<Row> = { [P in keyof Row]-?: Row[P] extends MirrorKey ? P : never }[keyof Row] & string;

/**
 * Defines a table a `MemoryMirror` keeps in memory. `schema` describes a row: the server stores rows
 * as its `Type`, sends them as its `Encoded` form, and clients decode them on arrival, so the schema
 * must encode to a plain object that survives structured cloning.
 */
export function memoryTable<S extends Schema.Codec<object, MirrorRow>, const K extends MemoryKeyProperty<S["Type"]>>(
  name: string,
  schema: S,
  options: { readonly primaryKey: K },
): MemoryTable<S["Type"], S["Type"][K] & MirrorKey> {
  const { primaryKey } = options;
  const encode = Schema.encodeSync(schema);
  const decode = Schema.decodeUnknownSync(schema);
  const keyOf = (row: S["Type"]) => {
    const key: unknown = (row as Record<string, unknown>)[primaryKey];
    if (typeof key === "string" || (typeof key === "number" && Number.isFinite(key))) return key as S["Type"][K] & MirrorKey;
    throw new Error(`Row of "${name}" has no usable key in "${primaryKey}"`);
  };
  return { [MemoryTableTypeId]: true, name, primaryKey, keyOf, encode: (row) => encode(row), decode: (encoded) => decode(encoded) };
}
