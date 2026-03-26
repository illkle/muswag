import SubsonicAPI, { type AlbumID3, type AlbumWithSongsID3 } from "subsonic-api";

import type { MuswagDb } from "../db/database.js";
import { toAlbumRecord, toSongRecord } from "./toRecord.js";
import type { CoverArtStore } from "./utils.js";

const ALBUM_PAGE_SIZE = 500;
const ALBUM_DETAIL_CONCURRENCY = 8;

type CoverArtPathResult = string | null | undefined;

type SyncedAlbum = {
  album: AlbumWithSongsID3;
  coverArtPath: CoverArtPathResult;
};

export interface SyncAlbumsParams {
  api: SubsonicAPI;
  db: MuswagDb;
  coverArt: CoverArtStore;
  syncId: string;
}

export class SyncAbortedError extends Error {
  constructor() {
    super("Sync was aborted");
    this.name = "SyncAbortedError";
  }
}

function checkAborted(db: MuswagDb, syncId: string): void {
  const record = db.syncs.get(syncId);
  if (record && record.timeEnded !== null) {
    throw new SyncAbortedError();
  }
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
      const payload = await api.getAlbum({ id: album.id });
      return payload.album;
    } catch (cause) {
      lastCause = cause;
    }
  }

  throw lastCause ?? new Error(`Fetching album detail failed for ${album.id}`);
}

async function fetchAlbumDetails(api: SubsonicAPI, albums: AlbumID3[], coverArt: CoverArtStore): Promise<SyncedAlbum[]> {
  const detailedAlbums: SyncedAlbum[] = [];
  let nextIndex = 0;

  const workerCount = Math.min(ALBUM_DETAIL_CONCURRENCY, albums.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= albums.length) {
          return;
        }

        const listedAlbum = albums[currentIndex]!;
        const detailedAlbum = await fetchAlbumDetailWithRetry(api, listedAlbum);
        const coverArtPath = await coverArt.fetch(detailedAlbum.id, detailedAlbum.coverArt ?? null);
        detailedAlbums[currentIndex] = {
          album: detailedAlbum,
          coverArtPath,
        };
      }
    }),
  );

  return detailedAlbums;
}

function persistPage(
  db: MuswagDb,
  syncId: string,
  albums: SyncedAlbum[],
  syncedAlbumIds: Set<string>,
): { inserted: number; updated: number } {
  let inserted = 0;
  let updated = 0;

  for (const { album, coverArtPath } of albums) {
    checkAborted(db, syncId);

    const existing = db.albums.get(album.id);
    const exists = existing !== undefined;

    if (exists) {
      updated += 1;
    } else {
      inserted += 1;
    }

    const resolvedCoverArtPath = coverArtPath === undefined ? (existing?.coverArtPath ?? null) : coverArtPath;
    const albumRecord = toAlbumRecord(album, resolvedCoverArtPath);

    if (exists) {
      db.albums.delete(album.id);
    }
    db.albums.insert(albumRecord);

    syncedAlbumIds.add(album.id);

    // Persist songs: delete existing songs for this album, then insert new ones
    const existingSongIds: string[] = [];
    for (const [, song] of db.songs.entries()) {
      if (song.albumId === album.id) {
        existingSongIds.push(song.id);
      }
    }
    for (const songId of existingSongIds) {
      db.songs.delete(songId);
    }

    const songs = album.song ?? [];
    for (const song of songs) {
      const songRecord = toSongRecord(album, song);
      db.songs.insert(songRecord);
    }
  }

  return { inserted, updated };
}

function deleteMissingAlbums(db: MuswagDb, syncId: string, syncedAlbumIds: Set<string>): Array<{ id: string; coverArtPath: string | null }> {
  const albumsToDelete: Array<{ id: string; coverArtPath: string | null }> = [];

  for (const [, album] of db.albums.entries()) {
    if (!syncedAlbumIds.has(album.id)) {
      albumsToDelete.push({ id: album.id, coverArtPath: album.coverArtPath });
    }
  }

  for (const { id } of albumsToDelete) {
    checkAborted(db, syncId);

    // Delete all songs for this album
    const songIdsToDelete: string[] = [];
    for (const [, song] of db.songs.entries()) {
      if (song.albumId === id) {
        songIdsToDelete.push(song.id);
      }
    }
    for (const songId of songIdsToDelete) {
      db.songs.delete(songId);
    }

    // Delete the album
    db.albums.delete(id);
  }

  return albumsToDelete;
}

export async function syncAlbums(params: SyncAlbumsParams) {
  const { api, db, coverArt, syncId } = params;

  const syncedAlbumIds = new Set<string>();

  let fetched = 0;
  let inserted = 0;
  let updated = 0;
  let pages = 0;

  for (let offset = 0; ; offset += ALBUM_PAGE_SIZE) {
    checkAborted(db, syncId);

    const payload = await retry(
      () =>
        api.getAlbumList2({
          type: "alphabeticalByArtist",
          size: ALBUM_PAGE_SIZE,
          offset,
        }),
      2,
    );

    const albums = payload.albumList2?.album ?? [];
    const detailedAlbums = await fetchAlbumDetails(api, albums, coverArt);

    pages += 1;
    fetched += albums.length;

    const persisted = persistPage(db, syncId, detailedAlbums, syncedAlbumIds);
    inserted += persisted.inserted;
    updated += persisted.updated;

    if (albums.length < ALBUM_PAGE_SIZE) {
      break;
    }
  }

  const deletedAlbumRows = deleteMissingAlbums(db, syncId, syncedAlbumIds);
  const deleted = deletedAlbumRows.length;
  await Promise.all(deletedAlbumRows.map((album) => coverArt.remove(album.id)));
  const finishedAt = new Date().toISOString();

  return {
    fetched,
    inserted,
    updated,
    deleted,
    pages,
    finishedAt,
  };
}
