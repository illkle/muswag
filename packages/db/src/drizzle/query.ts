import { drizzle } from "drizzle-orm/sqlite-proxy";

import type { DbAdapter } from "../public-api.js";
import { albumsTable, syncAlbumIdsTable, syncStateTable } from "./schema.js";

type CompiledSql = {
  sql: string;
  params: readonly unknown[];
};

type SqlLike = {
  toSQL(): {
    sql: string;
    params: unknown[];
  };
};

const schema = {
  albums: albumsTable,
  syncState: syncStateTable,
  syncAlbumIds: syncAlbumIdsTable
};

export const dbq = drizzle(async () => ({ rows: [] }), { schema });

function compile(query: SqlLike): CompiledSql {
  const compiled = query.toSQL();
  return {
    sql: compiled.sql,
    params: compiled.params as readonly unknown[]
  };
}

export async function execQuery(adapter: DbAdapter, query: SqlLike): Promise<void> {
  const compiled = compile(query);
  await adapter.exec(compiled.sql, compiled.params);
}

export async function queryAll<T>(adapter: DbAdapter, query: SqlLike): Promise<T[]> {
  const compiled = compile(query);
  return adapter.query<T>(compiled.sql, compiled.params);
}

export async function queryOne<T>(adapter: DbAdapter, query: SqlLike): Promise<T | undefined> {
  const compiled = compile(query);
  return adapter.queryOne<T>(compiled.sql, compiled.params);
}
