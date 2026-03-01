import type { AlbumID3 } from "@muswag/opensubsonic-types";

import type { AlbumRow, DbAdapter, SyncAlbumsOptions, SyncAlbumsResult } from "./public-api.js";
import { migrate } from "./migrate.js";
import { fetchAlbumList2Page } from "./navidrome/client.js";

type RawAlbum = Partial<AlbumID3> & Record<string, unknown>;

const UPSERT_ALBUM_SQL = `
INSERT INTO albums (
  id,
  name,
  artist,
  artist_id,
  cover_art,
  song_count,
  duration,
  play_count,
  year,
  genre,
  created,
  starred,
  played,
  user_rating,
  sort_name,
  music_brainz_id,
  is_compilation,
  raw_json,
  synced_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  artist = excluded.artist,
  artist_id = excluded.artist_id,
  cover_art = excluded.cover_art,
  song_count = excluded.song_count,
  duration = excluded.duration,
  play_count = excluded.play_count,
  year = excluded.year,
  genre = excluded.genre,
  created = excluded.created,
  starred = excluded.starred,
  played = excluded.played,
  user_rating = excluded.user_rating,
  sort_name = excluded.sort_name,
  music_brainz_id = excluded.music_brainz_id,
  is_compilation = excluded.is_compilation,
  raw_json = excluded.raw_json,
  synced_at = excluded.synced_at
`;

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

export function normalizeAlbumForStorage(rawAlbum: RawAlbum, syncedAt: string): AlbumRow {
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
    syncedAt
  };
}

async function upsertAlbum(tx: DbAdapter, album: AlbumRow): Promise<void> {
  await tx.exec(UPSERT_ALBUM_SQL, [
    album.id,
    album.name,
    album.artist,
    album.artistId,
    album.coverArt,
    album.songCount,
    album.duration,
    album.playCount,
    album.year,
    album.genre,
    album.created,
    album.starred,
    album.played,
    album.userRating,
    album.sortName,
    album.musicBrainzId,
    album.isCompilation === null ? null : album.isCompilation ? 1 : 0,
    album.rawJson,
    album.syncedAt
  ]);
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
  await options.db.exec("DELETE FROM sync_album_ids");

  for (;;) {
    const fetchPageOptions =
      options.fetchImpl === undefined
        ? {
            connection: options.connection,
            offset,
            size: pageSize
          }
        : {
            connection: options.connection,
            offset,
            size: pageSize,
            fetchImpl: options.fetchImpl
          };

    const page = await fetchAlbumList2Page({
      ...fetchPageOptions
    });

    pages += 1;
    fetched += page.albums.length;
    const syncedAt = new Date().toISOString();

    await options.db.transaction(async (tx) => {
      for (const rawAlbum of page.albums) {
        const album = normalizeAlbumForStorage(rawAlbum, syncedAt);
        const existing = await tx.queryOne<{ id: string }>("SELECT id FROM albums WHERE id = ?", [album.id]);

        if (existing) {
          updated += 1;
        } else {
          inserted += 1;
        }

        await upsertAlbum(tx, album);
        await tx.exec("INSERT INTO sync_album_ids (id) VALUES (?) ON CONFLICT(id) DO NOTHING", [album.id]);
      }
    });

    if (page.albums.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  const deleteCountRow = await options.db.queryOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM albums WHERE id NOT IN (SELECT id FROM sync_album_ids)"
  );
  const deleted = Number(deleteCountRow?.count ?? 0);

  const finishedAt = new Date().toISOString();

  await options.db.transaction(async (tx) => {
    await tx.exec("DELETE FROM albums WHERE id NOT IN (SELECT id FROM sync_album_ids)");
    await tx.exec(
      "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ["albums_last_synced_at", finishedAt]
    );
    await tx.exec("DELETE FROM sync_album_ids");
  });

  return {
    fetched,
    inserted,
    updated,
    deleted,
    pages,
    startedAt,
    finishedAt
  };
}
