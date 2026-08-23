/*

import SubsonicAPI from "../subsonic-api.js";
import type { AlbumID3, AlbumWithSongsID3 } from "../subsonic-api-schema.js";

import type { Album, MuswagDb, Song } from "../db/database.js";
import { updateSyncProgress } from "./progress.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUM_DETAIL_CONCURRENCY = 8;

export type SyncAlbumMode = "full" | "quick";

export interface SyncAlbumsParams {
  api: SubsonicAPI;
  db: MuswagDb;
  syncId: string;
  mode: SyncAlbumMode;
}

export class SyncAbortedError extends Error {
  constructor() {
    super("Sync was aborted");
    this.name = "SyncAbortedError";
  }
}

function checkAborted(db: MuswagDb, syncId: string): void {
  const record = db.syncs.get(syncId);
  if (record && record.timeEnded !== null) throw new SyncAbortedError();
}

async function retry<A>(run: () => Promise<A>, times: number): Promise<A> {
  let lastCause: unknown;
  for (let attempt = 0; attempt <= times; attempt += 1) {
    try {
      return await run();
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw lastCause ?? new Error("Retry operation failed");
}

async function fetchAlbumDetailWithRetry(api: SubsonicAPI, album: AlbumID3): Promise<AlbumWithSongsID3> {
  let lastCause: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return (await api.getAlbum({ id: album.id })).album;
    } catch (cause) {
      lastCause = cause;
    }
  }
  throw lastCause ?? new Error(`Fetching album detail failed for ${album.id}`);
}

async function fetchAlbumDetails(api: SubsonicAPI, albums: AlbumID3[], onAlbumFetched?: () => void): Promise<AlbumWithSongsID3[]> {
  const detailedAlbums: AlbumWithSongsID3[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(ALBUM_DETAIL_CONCURRENCY, albums.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex++;
        const listedAlbum = albums[currentIndex];
        if (!listedAlbum) return;
        detailedAlbums[currentIndex] = await fetchAlbumDetailWithRetry(api, listedAlbum);
        onAlbumFetched?.();
      }
    }),
  );
  return detailedAlbums;
}

function unchangedShape(existing: Album, incoming: AlbumID3): boolean {
  return (
    existing.songCount === incoming.songCount &&
    existing.duration === incoming.duration &&
    existing.created === incoming.created &&
    existing.name === incoming.name &&
    existing.artist === incoming.artist
  );
}

function songIdsByAlbum(db: MuswagDb): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [, song] of db.songs.entries()) {
    if (!song.albumId) continue;
    const ids = result.get(song.albumId) ?? [];
    ids.push(song.id);
    result.set(song.albumId, ids);
  }
  return result;
}

function persistDetailedPage(db: MuswagDb, syncId: string, albums: AlbumWithSongsID3[], syncedAlbumIds: Set<string>): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;
  const albumIdsToDelete: string[] = [];
  const albumsToInsert: Album[] = [];
  const songIdsToDelete = new Set<string>();
  const songsToInsert: Song[] = [];
  const existingSongs = songIdsByAlbum(db);

  for (const album of albums) {
    checkAborted(db, syncId);
    const existing = db.albums.get(album.id);
    if (existing) {
      updated += 1;
      albumIdsToDelete.push(album.id);
    } else {
      inserted += 1;
    }

    const { song: songs = [], ...albumData } = album;
    albumsToInsert.push({
      ...albumData,
      coverArtPath: existing?.coverArtPath,
      coverArtSourceId: existing?.coverArtSourceId,
      statsRefreshedAt: existing?.statsRefreshedAt,
    });
    syncedAlbumIds.add(album.id);

    for (const songId of existingSongs.get(album.id) ?? []) songIdsToDelete.add(songId);
    for (const song of songs) {
      if (db.songs.get(song.id)) songIdsToDelete.add(song.id);
      songsToInsert.push({ ...song, albumId: album.id });
    }
  }

  if (albumIdsToDelete.length) db.albums.delete(albumIdsToDelete);
  if (albumsToInsert.length) db.albums.insert(albumsToInsert);
  if (songIdsToDelete.size) db.songs.delete([...songIdsToDelete]);
  if (songsToInsert.length) db.songs.insert(songsToInsert);
  return { inserted, updated };
}

function persistQuickRows(db: MuswagDb, albums: AlbumID3[], syncedAlbumIds: Set<string>): number {
  let updated = 0;
  for (const album of albums) {
    syncedAlbumIds.add(album.id);
    db.albums.update(album.id, (draft) => {
      Object.assign(draft, album);
    });
    updated += 1;
  }
  return updated;
}

function deleteMissingAlbums(db: MuswagDb, syncId: string, syncedAlbumIds: Set<string>): string[] {
  const albumIdsToDelete: string[] = [];
  for (const [id] of db.albums.entries()) if (!syncedAlbumIds.has(id)) albumIdsToDelete.push(id);
  const existingSongs = songIdsByAlbum(db);
  const songIdsToDelete: string[] = [];
  for (const id of albumIdsToDelete) {
    checkAborted(db, syncId);
    songIdsToDelete.push(...(existingSongs.get(id) ?? []));
  }
  if (albumIdsToDelete.length) db.albums.delete(albumIdsToDelete);
  if (songIdsToDelete.length) db.songs.delete(songIdsToDelete);
  return albumIdsToDelete;
}

function deleteDanglingSongs(db: MuswagDb, syncedAlbumIds: Set<string>): number {
  const ids: string[] = [];
  for (const [, song] of db.songs.entries()) if (!syncedAlbumIds.has(song.albumId ?? "")) ids.push(song.id);
  if (ids.length) db.songs.delete(ids);
  return ids.length;
}

export async function syncAlbums(params: SyncAlbumsParams) {
  const { api, db, syncId, mode } = params;
  const syncedAlbumIds = new Set<string>();
  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pages = 0;
  let detailRequests = 0;

  for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
    checkAborted(db, syncId);
    updateSyncProgress(db, syncId, {
      currentStep: "fetching-album-list",
      progress: { currentPage: pages + 1, currentPageSize: 0, currentPageAlbumDetailsFetched: 0, currentPageAlbumDetailsTotal: 0 },
    });

    const payload = await retry(() => api.getAlbumList2({ type: "alphabeticalByArtist", size: ALBUM_PAGE_SIZE, offset }), 2);
    const albums = payload.albumList2?.album ?? [];
    pages += 1;
    fetched += albums.length;

    const quickRows: AlbumID3[] = [];
    const detailRows =
      mode === "full"
        ? albums
        : albums.filter((album) => {
            const existing = db.albums.get(album.id);
            if (existing && unchangedShape(existing, album)) {
              quickRows.push(album);
              return false;
            }
            return true;
          });
    for (const album of quickRows) syncedAlbumIds.add(album.id);
    detailRequests += detailRows.length;

    updateSyncProgress(db, syncId, {
      currentStep: "fetching-album-details",
      progress: {
        pagesFetched: pages,
        albumsFetched: fetched,
        currentPage: pages,
        currentPageSize: albums.length,
        currentPageAlbumDetailsFetched: 0,
        currentPageAlbumDetailsTotal: detailRows.length,
      },
    });

    let detailsFetched = 0;
    const detailedAlbums = await fetchAlbumDetails(api, detailRows, () => {
      detailsFetched += 1;
      if (detailsFetched % 10 === 0 || detailsFetched === detailRows.length) {
        updateSyncProgress(db, syncId, { progress: { currentPageAlbumDetailsFetched: detailsFetched } });
      }
    });

    updateSyncProgress(db, syncId, { currentStep: "saving-albums" });
    updated += persistQuickRows(db, quickRows, syncedAlbumIds);
    const persisted = persistDetailedPage(db, syncId, detailedAlbums, syncedAlbumIds);
    inserted += persisted.inserted;
    updated += persisted.updated;
    updateSyncProgress(db, syncId, { progress: { albumsInserted: inserted, albumsUpdated: updated } });

    if (albums.length < ALBUM_PAGE_SIZE) break;
  }

  updateSyncProgress(db, syncId, { currentStep: "removing-missing-albums" });
  const deletedAlbumIds = deleteMissingAlbums(db, syncId, syncedAlbumIds);
  updateSyncProgress(db, syncId, {
    currentStep: mode === "full" ? "removing-dangling-songs" : detailRequests === 0 && deletedAlbumIds.length === 0 ? "skipped-unchanged" : "removing-missing-albums",
    progress: { albumsDeleted: deletedAlbumIds.length },
  });
  const songsDeleted = mode === "full" ? deleteDanglingSongs(db, syncedAlbumIds) : 0;
  updateSyncProgress(db, syncId, { progress: { songsDeleted } });

  return {
    fetched,
    inserted,
    updated,
    deleted: deletedAlbumIds.length,
    deletedAlbumIds,
    pages,
    detailRequests,
    finishedAt: new Date().toISOString(),
  };
}
*/
