export type SqliteQueryMethod = "all" | "get" | "run" | "values";

export interface SqliteQueryRequest {
  sql: string;
  params: unknown[];
  method: SqliteQueryMethod;
}

export interface SqliteQueryResponse {
  rows: unknown;
}

export interface MuswagDesktopApi {
  querySqlite: (request: SqliteQueryRequest) => Promise<SqliteQueryResponse>;
}
