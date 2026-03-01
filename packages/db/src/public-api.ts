export interface DbAdapter {
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>;
}

export interface AlbumRow {
  id: string;
  name: string;
  artist: string | null;
  artistId: string | null;
  coverArt: string | null;
  songCount: number;
  duration: number;
  playCount: number | null;
  year: number | null;
  genre: string | null;
  created: string;
  starred: string | null;
  played: string | null;
  userRating: number | null;
  sortName: string | null;
  musicBrainzId: string | null;
  isCompilation: boolean | null;
  rawJson: string;
  syncedAt: string;
}

export interface NavidromeConnection {
  baseUrl: string;
  username: string;
  password: string;
  clientName: string;
  protocolVersion?: string;
}

export interface SyncAlbumsOptions {
  db: DbAdapter;
  connection: NavidromeConnection;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

export interface SyncAlbumsResult {
  fetched: number;
  inserted: number;
  updated: number;
  deleted: number;
  pages: number;
  startedAt: string;
  finishedAt: string;
}
