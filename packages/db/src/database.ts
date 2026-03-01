import { z } from "zod";

import { migrate } from "./migrate.js";
import type { DatabaseSyncOptions, DbAdapter, SyncAlbumsResult } from "./public-api.js";
import { AlbumSchema, GetAlbumListOptionsSchema, type Album, type GetAlbumListOptions } from "./schemas.js";
import { syncAlbums } from "./sync-albums.js";

const AlbumQueryRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string().nullable(),
  artistId: z.string().nullable(),
  coverArt: z.string().nullable(),
  songCount: z.number().int(),
  duration: z.number().int(),
  playCount: z.number().int().nullable(),
  year: z.number().int().nullable(),
  genre: z.string().nullable(),
  created: z.string(),
  starred: z.string().nullable(),
  played: z.string().nullable(),
  userRating: z.number().int().nullable(),
  sortName: z.string().nullable(),
  musicBrainzId: z.string().nullable(),
  isCompilationRaw: z.number().int().nullable(),
  syncedAt: z.string()
});

type AlbumQueryRow = z.infer<typeof AlbumQueryRowSchema>;

const SELECT_ALBUM_COLUMNS = `
  id,
  name,
  artist,
  artist_id AS artistId,
  cover_art AS coverArt,
  song_count AS songCount,
  duration,
  play_count AS playCount,
  year,
  genre,
  created,
  starred,
  played,
  user_rating AS userRating,
  sort_name AS sortName,
  music_brainz_id AS musicBrainzId,
  is_compilation AS isCompilationRaw,
  synced_at AS syncedAt
`;

function mapRowToAlbum(input: unknown): Album {
  const row: AlbumQueryRow = AlbumQueryRowSchema.parse(input);

  const isCompilation =
    row.isCompilationRaw === null ? null : row.isCompilationRaw === 1 ? true : false;

  return AlbumSchema.parse({
    ...row,
    isCompilation
  });
}

export class Database {
  private readonly adapter: DbAdapter;

  constructor(adapter: DbAdapter) {
    this.adapter = adapter;
  }

  async sync(options: DatabaseSyncOptions): Promise<SyncAlbumsResult> {
    const baseOptions =
      options.pageSize === undefined
        ? {
            db: this.adapter,
            connection: options.connection
          }
        : {
            db: this.adapter,
            connection: options.connection,
            pageSize: options.pageSize
          };

    const syncOptions =
      options.fetchImpl === undefined
        ? baseOptions
        : {
            ...baseOptions,
            fetchImpl: options.fetchImpl
          };

    return syncAlbums(syncOptions);
  }

  async getAlbumList(options: GetAlbumListOptions = {}): Promise<Album[]> {
    const parsedOptions = GetAlbumListOptionsSchema.parse(options);
    const limit = parsedOptions.limit ?? 1000;
    const offset = parsedOptions.offset ?? 0;

    await migrate(this.adapter);

    const rows = await this.adapter.query<unknown>(
      `SELECT ${SELECT_ALBUM_COLUMNS} FROM albums ORDER BY name COLLATE NOCASE ASC, id ASC LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    return rows.map(mapRowToAlbum);
  }

  async getAlbumById(id: string): Promise<Album | null> {
    const albumId = z.string().min(1).parse(id);

    await migrate(this.adapter);

    const row = await this.adapter.queryOne<unknown>(
      `SELECT ${SELECT_ALBUM_COLUMNS} FROM albums WHERE id = ? LIMIT 1`,
      [albumId]
    );

    return row ? mapRowToAlbum(row) : null;
  }
}
