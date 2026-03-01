import type { AlbumID3 } from "@muswag/opensubsonic-types";
import { eq, notInArray, sql } from "drizzle-orm";

import type {
  DatabaseSyncOptions,
  DbAdapter,
  NavidromeConnection,
  SyncAlbumsResult,
} from "./public-api.js";
import { migrate } from "./migrate.js";
import { fetchAlbumList2Page } from "./navidrome/client.js";
import { dbq, execQuery, queryOne } from "./drizzle/query.js";
import { albumsTable, syncAlbumIdsTable, syncStateTable } from "./drizzle/schema.js";

type RawAlbum = Partial<AlbumID3> & Record<string, unknown>;
type AlbumRow = {
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
};

type SyncAlbumsOptions = DatabaseSyncOptions & {
  db: DbAdapter;
  connection: NavidromeConnection;
};

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function toNullableInteger(value: unknown): number | null {
  const numberValue = toNullableNumber(value);
  if (numberValue === null) {
    return null;
  }

  return Number.isInteger(numberValue) ? numberValue : Math.trunc(numberValue);
}

function toNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
  }

  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (lowered === "true" || lowered === "1") {
      return true;
    }
    if (lowered === "false" || lowered === "0") {
      return false;
    }
  }

  return null;
}

function requireString(value: unknown, field: string): string {
  const result = toNullableString(value);
  if (!result) {
    throw new Error(`Album is missing required string field: ${field}`);
  }
  return result;
}

function requireInteger(value: unknown, field: string): number {
  const result = toNullableInteger(value);
  if (result === null) {
    throw new Error(`Album is missing required integer field: ${field}`);
  }
  return result;
}

function normalizeAlbumForStorage(rawAlbum: RawAlbum, syncedAt: string): AlbumRow {
  const id = requireString(rawAlbum.id, "id");
  const name =
    toNullableString(rawAlbum.name) ??
    toNullableString(rawAlbum.album) ??
    toNullableString(rawAlbum.title);

  if (!name) {
    throw new Error(`Album ${id} is missing name/album/title`);
  }

  const created = toNullableString(rawAlbum.created) ?? syncedAt;

  return {
    id,
    name,
    artist: toNullableString(rawAlbum.artist),
    artistId: toNullableString(rawAlbum.artistId),
    coverArt: toNullableString(rawAlbum.coverArt),
    songCount: requireInteger(rawAlbum.songCount, "songCount"),
    duration: requireInteger(rawAlbum.duration, "duration"),
    playCount: toNullableInteger(rawAlbum.playCount),
    year: toNullableInteger(rawAlbum.year),
    genre: toNullableString(rawAlbum.genre),
    created,
    starred: toNullableString(rawAlbum.starred),
    played: toNullableString(rawAlbum.played),
    userRating: toNullableInteger(rawAlbum.userRating),
    sortName: toNullableString(rawAlbum.sortName),
    musicBrainzId: toNullableString(rawAlbum.musicBrainzId),
    isCompilation: toNullableBoolean(rawAlbum.isCompilation),
    rawJson: JSON.stringify(rawAlbum),
    syncedAt,
  };
}

async function upsertAlbum(tx: DbAdapter, album: AlbumRow): Promise<void> {
  const compilation = album.isCompilation === null ? null : album.isCompilation ? 1 : 0;

  const query = dbq
    .insert(albumsTable)
    .values({
      id: album.id,
      name: album.name,
      artist: album.artist,
      artistId: album.artistId,
      coverArt: album.coverArt,
      songCount: album.songCount,
      duration: album.duration,
      playCount: album.playCount,
      year: album.year,
      genre: album.genre,
      created: album.created,
      starred: album.starred,
      played: album.played,
      userRating: album.userRating,
      sortName: album.sortName,
      musicBrainzId: album.musicBrainzId,
      isCompilation: compilation,
      rawJson: album.rawJson,
      syncedAt: album.syncedAt,
    })
    .onConflictDoUpdate({
      target: albumsTable.id,
      set: {
        name: album.name,
        artist: album.artist,
        artistId: album.artistId,
        coverArt: album.coverArt,
        songCount: album.songCount,
        duration: album.duration,
        playCount: album.playCount,
        year: album.year,
        genre: album.genre,
        created: album.created,
        starred: album.starred,
        played: album.played,
        userRating: album.userRating,
        sortName: album.sortName,
        musicBrainzId: album.musicBrainzId,
        isCompilation: compilation,
        rawJson: album.rawJson,
        syncedAt: album.syncedAt,
      },
    });
  await execQuery(tx, query);
}

function resolvePageSize(requested: number | undefined): number {
  if (requested === undefined) {
    return 500;
  }

  if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
    throw new Error("pageSize must be an integer between 1 and 500");
  }

  return requested;
}

export async function syncAlbums(options: SyncAlbumsOptions): Promise<SyncAlbumsResult> {
  const pageSize = resolvePageSize(options.pageSize);
  const startedAt = new Date().toISOString();

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pages = 0;
  let offset = 0;

  await migrate(options.db);
  await execQuery(options.db, dbq.delete(syncAlbumIdsTable));

  for (;;) {
    const fetchPageOptions =
      options.fetchImpl === undefined
        ? {
            connection: options.connection,
            offset,
            size: pageSize,
          }
        : {
            connection: options.connection,
            offset,
            size: pageSize,
            fetchImpl: options.fetchImpl,
          };

    const page = await fetchAlbumList2Page({
      ...fetchPageOptions,
    });

    pages += 1;
    fetched += page.albums.length;
    const syncedAt = new Date().toISOString();

    await options.db.transaction(async (tx) => {
      for (const rawAlbum of page.albums) {
        const album = normalizeAlbumForStorage(rawAlbum, syncedAt);

        const existsQuery = dbq
          .select({ id: albumsTable.id })
          .from(albumsTable)
          .where(eq(albumsTable.id, album.id))
          .limit(1);
        const existing = await queryOne<{ id: string }>(tx, existsQuery);

        if (existing) {
          updated += 1;
        } else {
          inserted += 1;
        }

        await upsertAlbum(tx, album);

        const touchedIdsQuery = dbq
          .insert(syncAlbumIdsTable)
          .values({ id: album.id })
          .onConflictDoNothing();
        await execQuery(tx, touchedIdsQuery);
      }
    });

    if (page.albums.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  const missingIdsSubquery = dbq.select({ id: syncAlbumIdsTable.id }).from(syncAlbumIdsTable);

  const countStaleQuery = dbq
    .select({ count: sql<number>`count(*)` })
    .from(albumsTable)
    .where(notInArray(albumsTable.id, missingIdsSubquery));
  const deleteCountRow = await queryOne<Record<string, unknown>>(options.db, countStaleQuery);
  const deletedRaw =
    deleteCountRow?.count ?? deleteCountRow?.["count(*)"] ?? deleteCountRow?.["count"];
  const deleted = Number(deletedRaw ?? 0);

  const finishedAt = new Date().toISOString();

  await options.db.transaction(async (tx) => {
    const txMissingIdsSubquery = dbq.select({ id: syncAlbumIdsTable.id }).from(syncAlbumIdsTable);
    const deleteQuery = dbq
      .delete(albumsTable)
      .where(notInArray(albumsTable.id, txMissingIdsSubquery));
    await execQuery(tx, deleteQuery);

    const syncStateUpsert = dbq
      .insert(syncStateTable)
      .values({ key: "albums_last_synced_at", value: finishedAt })
      .onConflictDoUpdate({
        target: syncStateTable.key,
        set: { value: finishedAt },
      });
    await execQuery(tx, syncStateUpsert);

    await execQuery(tx, dbq.delete(syncAlbumIdsTable));
  });

  return {
    fetched,
    inserted,
    updated,
    deleted,
    pages,
    startedAt,
    finishedAt,
  };
}
