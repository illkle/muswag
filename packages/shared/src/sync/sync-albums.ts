import SubsonicAPI, { type AlbumID3, type AlbumWithSongsID3 } from "@muswag/subsonic-api";

import type { Album, MuswagDb, Song } from "../db/database.js";
import { updateSyncProgress } from "./progress.js";
import type { CoverArtStore } from "./covers-helper.js";

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

async function fetchAlbumDetails(
  api: SubsonicAPI,
  albums: AlbumID3[],
  coverArt: CoverArtStore,
  onAlbumFetched?: () => void,
): Promise<SyncedAlbum[]> {
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
        onAlbumFetched?.();
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

  const albumIDsToDelete: string[] = [];
  const albumsToInsert: Album[] = [];

  const songIDsToDelete: string[] = [];
  const songsToInsert: Song[] = [];

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
    const albumRecord = { ...album, coverArtPath: resolvedCoverArtPath ?? undefined };

    if (exists) {
      albumIDsToDelete.push(album.id);
    }
    albumsToInsert.push(albumRecord);

    syncedAlbumIds.add(album.id);

    const songs = album.song ?? [];
    const incomingSongIds = new Set(songs.map((song) => song.id));

    // Persist songs: delete existing songs for this album, then insert new ones.
    // Also delete by incoming song ID so older rows with non-canonical albumId values
    // are replaced during the next sync.
    const existingSongIds: string[] = [];
    for (const [, song] of db.songs.entries()) {
      if (song.albumId === album.id || incomingSongIds.has(song.id)) {
        existingSongIds.push(song.id);
      }
    }
    for (const songId of existingSongIds) {
      songIDsToDelete.push(songId);
    }

    for (const song of songs) {
      songsToInsert.push({ ...song, albumId: album.id });
    }
  }

  if (albumIDsToDelete.length) db.albums.delete(albumIDsToDelete);
  if (albumsToInsert.length) db.albums.insert(albumsToInsert);
  if (songIDsToDelete.length) db.songs.delete(songIDsToDelete);
  if (songsToInsert.length) db.songs.insert(songsToInsert);

  return { inserted, updated };
}

function deleteMissingAlbums(
  db: MuswagDb,
  syncId: string,
  syncedAlbumIds: Set<string>,
): Array<{ id: string; coverArtPath: string | undefined }> {
  const albumsToDelete: Array<{ id: string; coverArtPath: string | undefined }> = [];

  for (const [, album] of db.albums.entries()) {
    if (!syncedAlbumIds.has(album.id)) {
      albumsToDelete.push({ id: album.id, coverArtPath: album.coverArtPath });
    }
  }

  const albumIdsToDelete: string[] = [];
  const songIdsToDelete: string[] = [];

  for (const { id } of albumsToDelete) {
    checkAborted(db, syncId);

    for (const [, song] of db.songs.entries()) {
      if (song.albumId === id) {
        songIdsToDelete.push(song.id);
      }
    }
    albumIdsToDelete.push(id);
  }

  if (albumIdsToDelete.length) db.albums.delete(albumIdsToDelete);
  if (songIdsToDelete.length) db.songs.delete(songIdsToDelete);

  return albumsToDelete;
}

function deleteDanglingSongs(db: MuswagDb, syncedAlbumIds: Set<string>): number {
  const songIdsToDelete: string[] = [];

  for (const [, song] of db.songs.entries()) {
    if (!syncedAlbumIds.has(song.albumId ?? "")) {
      songIdsToDelete.push(song.id);
    }
  }

  if (songIdsToDelete.length) db.songs.delete(songIdsToDelete);

  return songIdsToDelete.length;
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

    updateSyncProgress(db, syncId, {
      currentStep: "fetching-album-list",
      progress: {
        currentPage: pages + 1,
        currentPageSize: 0,
        currentPageAlbumDetailsFetched: 0,
        currentPageAlbumDetailsTotal: 0,
      },
    });

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
    pages += 1;
    fetched += albums.length;

    updateSyncProgress(db, syncId, {
      currentStep: "fetching-album-details",
      progress: {
        pagesFetched: pages,
        albumsFetched: fetched,
        currentPage: pages,
        currentPageSize: albums.length,
        currentPageAlbumDetailsFetched: 0,
        currentPageAlbumDetailsTotal: albums.length,
      },
    });

    let currentPageAlbumDetailsFetched = 0;
    const detailedAlbums = await fetchAlbumDetails(api, albums, coverArt, () => {
      currentPageAlbumDetailsFetched += 1;
      if (currentPageAlbumDetailsFetched % 10 !== 0 && currentPageAlbumDetailsFetched !== albums.length) {
        return;
      }

      updateSyncProgress(db, syncId, {
        currentStep: "fetching-album-details",
        progress: {
          currentPageAlbumDetailsFetched,
          currentPageAlbumDetailsTotal: albums.length,
        },
      });
    });

    updateSyncProgress(db, syncId, {
      currentStep: "saving-albums",
      progress: {
        currentPageAlbumDetailsFetched: albums.length,
        currentPageAlbumDetailsTotal: albums.length,
      },
    });

    const persisted = persistPage(db, syncId, detailedAlbums, syncedAlbumIds);
    inserted += persisted.inserted;
    updated += persisted.updated;

    updateSyncProgress(db, syncId, {
      currentStep: "saving-albums",
      progress: {
        albumsInserted: inserted,
        albumsUpdated: updated,
      },
    });

    if (albums.length < ALBUM_PAGE_SIZE) {
      break;
    }
  }

  updateSyncProgress(db, syncId, { currentStep: "removing-missing-albums" });
  const deletedAlbumRows = deleteMissingAlbums(db, syncId, syncedAlbumIds);
  const deleted = deletedAlbumRows.length;
  updateSyncProgress(db, syncId, {
    currentStep: "removing-dangling-songs",
    progress: {
      albumsDeleted: deleted,
    },
  });

  const songsDeleted = deleteDanglingSongs(db, syncedAlbumIds);
  updateSyncProgress(db, syncId, {
    currentStep: "removing-cover-art",
    progress: {
      songsDeleted,
    },
  });

  let coverArtDeleted = 0;
  await Promise.all(
    deletedAlbumRows.map(async (album) => {
      await coverArt.remove(album.id);
      coverArtDeleted += 1;
      updateSyncProgress(db, syncId, {
        currentStep: "removing-cover-art",
        progress: {
          coverArtDeleted,
        },
      });
    }),
  );
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
