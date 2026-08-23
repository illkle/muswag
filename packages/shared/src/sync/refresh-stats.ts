/*
import SubsonicAPI from "../subsonic-api.js";
import type { AlbumID3, Child } from "../subsonic-api-schema.js";

import type { MuswagDb } from "../db/database.js";

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const albumInFlight = new WeakMap<MuswagDb, Map<string, Promise<boolean>>>();
const playlistInFlight = new WeakMap<MuswagDb, Map<string, Promise<number>>>();
const playlistRefreshedAt = new WeakMap<MuswagDb, Map<string, number>>();

const ALBUM_STAT_FIELDS = ["playCount", "played", "starred", "userRating"] as const;
const SONG_STAT_FIELDS = ["playCount", "played", "starred", "userRating", "averageRating", "bookmarkPosition"] as const;

function assignFields<T extends object, K extends keyof T>(draft: T, source: T, fields: readonly K[]): void {
  for (const field of fields) {
    if (field in source) draft[field] = source[field];
    else delete draft[field];
  }
}

export async function refreshAlbumStats(db: MuswagDb, api: SubsonicAPI, albumId: string, opts: { maxAgeMs?: number } = {}): Promise<boolean> {
  const album = db.albums.get(albumId);
  if (!album) return false;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (album.statsRefreshedAt && Date.now() - Date.parse(album.statsRefreshedAt) < maxAgeMs) return false;

  let byId = albumInFlight.get(db);
  if (!byId) {
    byId = new Map();
    albumInFlight.set(db, byId);
  }
  const existing = byId.get(albumId);
  if (existing) return existing;

  const promise = (async () => {
    const { album: incoming } = await api.getAlbum({ id: albumId });
    if (!db.albums.get(albumId)) return true;
    const refreshedAt = new Date().toISOString();
    db.albums.update(albumId, (draft) => {
      assignFields(draft, incoming as AlbumID3, ALBUM_STAT_FIELDS);
      draft.statsRefreshedAt = refreshedAt;
    });
    for (const song of incoming.song ?? []) {
      if (!db.songs.get(song.id)) continue;
      db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
    }
    return true;
  })().finally(() => byId!.delete(albumId));
  byId.set(albumId, promise);
  return promise;
}

export async function refreshPlaylistSongStats(db: MuswagDb, api: SubsonicAPI, playlistId: string, opts: { maxAgeMs?: number } = {}): Promise<number> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  let refreshed = playlistRefreshedAt.get(db);
  if (!refreshed) {
    refreshed = new Map();
    playlistRefreshedAt.set(db, refreshed);
  }
  if (Date.now() - (refreshed.get(playlistId) ?? 0) < maxAgeMs) return 0;

  let byId = playlistInFlight.get(db);
  if (!byId) {
    byId = new Map();
    playlistInFlight.set(db, byId);
  }
  const existing = byId.get(playlistId);
  if (existing) return existing;

  const promise = (async () => {
    const { playlist } = await api.getPlaylist({ id: playlistId });
    let updated = 0;
    for (const song of playlist.entry ?? []) {
      if (!db.songs.get(song.id)) continue;
      db.songs.update(song.id, (draft) => assignFields(draft, song as Child, SONG_STAT_FIELDS));
      updated += 1;
    }
    refreshed!.set(playlistId, Date.now());
    return updated;
  })().finally(() => byId!.delete(playlistId));
  byId.set(playlistId, promise);
  return promise;
}
*/
