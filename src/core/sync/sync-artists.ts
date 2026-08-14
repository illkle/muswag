import SubsonicAPI, { SubsonicApiError, type IndexArtist } from "#subsonic-api";

import type { Artist, MuswagDb } from "../db/database.js";
import { updateSyncProgress } from "./progress.js";

export interface SyncArtistsResult {
  lastModified: number | null;
  libraryChanged: boolean;
  inserted: number;
  updated: number;
  deleted: number;
  deletedArtistIds: string[];
}

function artistMatches(existing: Artist, incoming: IndexArtist): boolean {
  return (
    existing.id === incoming.id &&
    existing.name === incoming.name &&
    existing.starred === incoming.starred &&
    existing.userRating === incoming.userRating &&
    existing.averageRating === incoming.averageRating &&
    existing.coverArt === incoming.coverArt &&
    existing.artistImageUrl === incoming.artistImageUrl
  );
}

export async function syncArtists(params: { api: SubsonicAPI; db: MuswagDb; syncId: string; ifModifiedSince?: number }): Promise<SyncArtistsResult> {
  const { api, db, syncId, ifModifiedSince } = params;
  updateSyncProgress(db, syncId, { currentStep: "fetching-artists" });

  let indexes: Awaited<ReturnType<SubsonicAPI["getIndexes"]>>["indexes"];
  let watermarkAvailable = true;
  try {
    ({ indexes } = await api.getIndexes(ifModifiedSince === undefined ? {} : { ifModifiedSince }));
  } catch (error) {
    if (!(error instanceof SubsonicApiError) || error.code !== 70) throw error;
    watermarkAvailable = false;
    indexes = { lastModified: 0, index: [] };
  }

  const libraryChanged = ifModifiedSince === undefined || indexes.index !== undefined;
  if (!libraryChanged) {
    return {
      lastModified: indexes.lastModified,
      libraryChanged: false,
      inserted: 0,
      updated: 0,
      deleted: 0,
      deletedArtistIds: [],
    };
  }

  const incoming = new Map<string, IndexArtist>();
  for (const index of indexes.index ?? []) {
    for (const artist of index.artist ?? []) incoming.set(artist.id, artist);
  }

  updateSyncProgress(db, syncId, {
    currentStep: "saving-artists",
    progress: { artistsFetched: incoming.size },
  });

  let inserted = 0;
  let updated = 0;
  const deletedArtistIds: string[] = [];
  for (const [id, artist] of incoming) {
    const existing = db.artists.get(id);
    if (!existing) {
      db.artists.insert({ ...artist });
      inserted += 1;
    } else if (!artistMatches(existing, artist)) {
      db.artists.update(id, (draft) => {
        Object.assign(draft, artist);
        for (const key of ["starred", "userRating", "averageRating", "coverArt", "artistImageUrl"] as const) {
          if (!(key in artist)) delete draft[key];
        }
      });
      updated += 1;
    }
  }

  for (const [id] of db.artists.entries()) {
    if (!incoming.has(id)) deletedArtistIds.push(id);
  }
  if (deletedArtistIds.length) db.artists.delete(deletedArtistIds);

  updateSyncProgress(db, syncId, {
    currentStep: "saving-artists",
    progress: { artistsInserted: inserted, artistsDeleted: deletedArtistIds.length },
  });

  return {
    lastModified: watermarkAvailable ? indexes.lastModified : null,
    libraryChanged: true,
    inserted,
    updated,
    deleted: deletedArtistIds.length,
    deletedArtistIds,
  };
}
