import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { dbq, queryAll, queryOne } from "./drizzle/query.js";
import { albumsTable } from "./drizzle/schema.js";
import { migrate } from "./migrate.js";
import type { DatabaseSyncOptions, DbAdapter, SyncAlbumsResult } from "./public-api.js";
import { AlbumSchema, GetAlbumListOptionsSchema, type Album, type GetAlbumListOptions } from "./schemas.js";
import { syncAlbums } from "./sync-albums.js";

function getRecordValue(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in input) {
      return input[key];
    }
  }
  return undefined;
}

function nullableString(input: Record<string, unknown>, keys: string[]): string | null {
  const value = getRecordValue(input, keys);
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function nullableInt(input: Record<string, unknown>, keys: string[]): number | null {
  const value = getRecordValue(input, keys);
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function requiredString(input: Record<string, unknown>, keys: string[]): string {
  const value = nullableString(input, keys);
  if (value === null || value.length === 0) {
    throw new Error(`Missing required string field: ${keys.join(" | ")}`);
  }
  return value;
}

function requiredInt(input: Record<string, unknown>, keys: string[]): number {
  const value = nullableInt(input, keys);
  if (value === null) {
    throw new Error(`Missing required integer field: ${keys.join(" | ")}`);
  }
  return value;
}

function mapRowToAlbum(input: unknown): Album {
  const row = z.record(z.unknown()).parse(input);
  const isCompilationRaw = nullableInt(row, ["isCompilationRaw", "is_compilation"]);
  const isCompilation =
    isCompilationRaw === null ? null : isCompilationRaw === 1 ? true : false;

  return AlbumSchema.parse({
    id: requiredString(row, ["id"]),
    name: requiredString(row, ["name"]),
    artist: nullableString(row, ["artist"]),
    artistId: nullableString(row, ["artistId", "artist_id"]),
    coverArt: nullableString(row, ["coverArt", "cover_art"]),
    songCount: requiredInt(row, ["songCount", "song_count"]),
    duration: requiredInt(row, ["duration"]),
    playCount: nullableInt(row, ["playCount", "play_count"]),
    year: nullableInt(row, ["year"]),
    genre: nullableString(row, ["genre"]),
    created: requiredString(row, ["created"]),
    starred: nullableString(row, ["starred"]),
    played: nullableString(row, ["played"]),
    userRating: nullableInt(row, ["userRating", "user_rating"]),
    sortName: nullableString(row, ["sortName", "sort_name"]),
    musicBrainzId: nullableString(row, ["musicBrainzId", "music_brainz_id"]),
    isCompilation,
    syncedAt: requiredString(row, ["syncedAt", "synced_at"])
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

    const query = dbq
      .select({
        id: albumsTable.id,
        name: albumsTable.name,
        artist: albumsTable.artist,
        artistId: albumsTable.artistId,
        coverArt: albumsTable.coverArt,
        songCount: albumsTable.songCount,
        duration: albumsTable.duration,
        playCount: albumsTable.playCount,
        year: albumsTable.year,
        genre: albumsTable.genre,
        created: albumsTable.created,
        starred: albumsTable.starred,
        played: albumsTable.played,
        userRating: albumsTable.userRating,
        sortName: albumsTable.sortName,
        musicBrainzId: albumsTable.musicBrainzId,
        isCompilationRaw: albumsTable.isCompilation,
        syncedAt: albumsTable.syncedAt
      })
      .from(albumsTable)
      .orderBy(asc(albumsTable.name), asc(albumsTable.id))
      .limit(limit)
      .offset(offset);

    const rows = await queryAll<unknown>(this.adapter, query);
    return rows.map(mapRowToAlbum);
  }

  async getAlbumById(id: string): Promise<Album | null> {
    const albumId = z.string().min(1).parse(id);

    await migrate(this.adapter);

    const query = dbq
      .select({
        id: albumsTable.id,
        name: albumsTable.name,
        artist: albumsTable.artist,
        artistId: albumsTable.artistId,
        coverArt: albumsTable.coverArt,
        songCount: albumsTable.songCount,
        duration: albumsTable.duration,
        playCount: albumsTable.playCount,
        year: albumsTable.year,
        genre: albumsTable.genre,
        created: albumsTable.created,
        starred: albumsTable.starred,
        played: albumsTable.played,
        userRating: albumsTable.userRating,
        sortName: albumsTable.sortName,
        musicBrainzId: albumsTable.musicBrainzId,
        isCompilationRaw: albumsTable.isCompilation,
        syncedAt: albumsTable.syncedAt
      })
      .from(albumsTable)
      .where(eq(albumsTable.id, albumId))
      .limit(1);

    const row = await queryOne<unknown>(this.adapter, query);
    return row ? mapRowToAlbum(row) : null;
  }
}
