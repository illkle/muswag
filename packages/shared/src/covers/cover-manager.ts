import type { MuswagDb } from "../db/database.js";
import type { CoverArtStore } from "./covers-helper.js";

const NEGATIVE_CACHE_MS = 60_000;
const DEFAULT_CONCURRENCY = 8;

export type CoverTarget = { type: "album" | "artist"; id: string; coverArtId: string | null };
export type CoverSweepResult = { completed: number; total: number };

export interface CoverManager {
  ensure(target: CoverTarget): Promise<string | null>;
  repair(target: CoverTarget, failedPath: string): Promise<string | null>;
  sweep(opts?: {
    signal?: AbortSignal;
    concurrency?: number;
    onProgress?: (done: number, total: number) => void;
  }): Promise<CoverSweepResult>;
  remove(target: Pick<CoverTarget, "type" | "id">): Promise<void>;
  pruneOrphans(): Promise<number>;
}

export function createCoverManager(params: { db: MuswagDb; store: CoverArtStore }): CoverManager {
  const { db, store } = params;
  const inFlight = new Map<string, Promise<string | null>>();
  const negativeCache = new Map<string, number>();

  const keyOf = (target: Pick<CoverTarget, "type" | "id">) => `${target.type}:${target.id}`;
  const rowFor = (target: Pick<CoverTarget, "type" | "id">) =>
    target.type === "album" ? db.albums.get(target.id) : db.artists.get(target.id);

  const updateRow = (target: CoverTarget, path: string | null): void => {
    if (target.type === "album") {
      if (!db.albums.get(target.id)) return;
      db.albums.update(target.id, (draft) => {
        draft.coverArtPath = path ?? undefined;
        draft.coverArtSourceId = path ? (target.coverArtId ?? undefined) : undefined;
      });
    } else {
      if (!db.artists.get(target.id)) return;
      db.artists.update(target.id, (draft) => {
        draft.coverArtPath = path ?? undefined;
        draft.coverArtSourceId = path ? (target.coverArtId ?? undefined) : undefined;
      });
    }
  };

  const fetchAndUpdate = async (target: CoverTarget, previousPath: string | undefined, fallbackPath: string | null) => {
    const key = keyOf(target);
    const result = await store.fetch(key, target.coverArtId);
    if (result === undefined) {
      negativeCache.set(key, Date.now() + NEGATIVE_CACHE_MS);
      return fallbackPath;
    }

    negativeCache.delete(key);
    updateRow(target, result);
    if (previousPath && previousPath !== result && store.removePath) {
      try {
        await store.removePath(previousPath);
      } catch (error) {
        console.warn("Failed to remove superseded cover art.", { path: previousPath, error });
      }
    }
    return result;
  };

  const manager: CoverManager = {
    async ensure(target) {
      const key = keyOf(target);
      const existingPromise = inFlight.get(key);
      if (existingPromise) return existingPromise;

      const row = rowFor(target);
      if (!row) return null;
      if (target.coverArtId === null) {
        await store.remove(key);
        updateRow(target, null);
        return null;
      }
      if (row.coverArtPath && (row.coverArtSourceId === target.coverArtId || row.coverArtSourceId === undefined)) {
        return row.coverArtPath;
      }
      if ((negativeCache.get(key) ?? 0) > Date.now()) return row.coverArtPath ?? null;

      const promise = fetchAndUpdate(target, row.coverArtPath, row.coverArtPath ?? null).finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    },

    async repair(target, failedPath) {
      const key = keyOf(target);
      const existingPromise = inFlight.get(key);
      if (existingPromise) return existingPromise;

      const row = rowFor(target);
      if (!row) return null;
      if (row.coverArtPath !== failedPath) return manager.ensure(target);

      negativeCache.delete(key);
      updateRow(target, null);
      const promise = fetchAndUpdate(target, failedPath, null).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },

    async sweep(opts = {}) {
      let cachedPaths: Set<string> | undefined;
      if (store.list) {
        try {
          cachedPaths = new Set(await store.list());
        } catch (error) {
          console.warn("Failed to inspect the cover cache; continuing without reconciliation.", { error });
        }
      }

      const targets: Array<{ target: CoverTarget; failedPath?: string }> = [];
      for (const [, album] of db.albums.entries()) {
        const missingFile = album.coverArtPath && cachedPaths && !cachedPaths.has(album.coverArtPath) ? album.coverArtPath : undefined;
        if (
          (album.coverArt &&
            (!album.coverArtPath || missingFile || (album.coverArtSourceId !== undefined && album.coverArtSourceId !== album.coverArt))) ||
          (!album.coverArt && album.coverArtPath)
        ) {
          targets.push({
            target: { type: "album", id: album.id, coverArtId: album.coverArt ?? null },
            ...(missingFile ? { failedPath: missingFile } : {}),
          });
        }
      }
      for (const [, artist] of db.artists.entries()) {
        const missingFile = artist.coverArtPath && cachedPaths && !cachedPaths.has(artist.coverArtPath) ? artist.coverArtPath : undefined;
        if (
          (artist.coverArt &&
            (!artist.coverArtPath ||
              missingFile ||
              (artist.coverArtSourceId !== undefined && artist.coverArtSourceId !== artist.coverArt))) ||
          (!artist.coverArt && artist.coverArtPath)
        ) {
          targets.push({
            target: { type: "artist", id: artist.id, coverArtId: artist.coverArt ?? null },
            ...(missingFile ? { failedPath: missingFile } : {}),
          });
        }
      }

      let nextIndex = 0;
      let completed = 0;
      const total = targets.length;
      opts.onProgress?.(0, total);
      const workerCount = Math.min(Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY), total);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (nextIndex < total) {
            if (opts.signal?.aborted) return;
            const candidate = targets[nextIndex++];
            if (!candidate) return;
            if (candidate.failedPath) {
              await manager.repair(candidate.target, candidate.failedPath);
            } else {
              await manager.ensure(candidate.target);
            }
            completed += 1;
            opts.onProgress?.(completed, total);
          }
        }),
      );
      return { completed, total };
    },

    async remove(target) {
      negativeCache.delete(keyOf(target));
      await store.remove(keyOf(target));
    },

    async pruneOrphans() {
      if (!store.list || !store.removePath) return 0;
      const referenced = new Set<string>();
      for (const [, album] of db.albums.entries()) if (album.coverArtPath) referenced.add(album.coverArtPath);
      for (const [, artist] of db.artists.entries()) if (artist.coverArtPath) referenced.add(artist.coverArtPath);

      const files = await store.list();
      const orphans = files.filter((path) => !referenced.has(path));
      await Promise.all(orphans.map((path) => store.removePath!(path)));
      return orphans.length;
    },
  };

  return manager;
}
