import { readFile, rename, stat, writeFile } from "node:fs/promises";

import type { ThumbnailSize } from "#shared/cover";

/**
 * Shorter side of each thumbnail in pixels, twice what it is shown at for a 2x display: a grid tile is
 * about 200 px wide, a list row's cover 40 px.
 */
export const THUMBNAIL_PIXELS: Record<ThumbnailSize, number> = { thumbnail: 400, icon: 96 };

const THUMBNAIL_SUFFIXES: Record<ThumbnailSize, string> = { thumbnail: "thumb", icon: "icon" };

/** Thumbnails sit next to their cover, so removing a cover can remove its thumbnails. */
export const thumbnailPathOf = (coverPath: string, size: ThumbnailSize): string => `${coverPath}.${THUMBNAIL_SUFFIXES[size]}`;

/** The files of every thumbnail of a cover, whether made or not. */
export const thumbnailPathsOf = (coverPath: string): string[] => Object.values(THUMBNAIL_SUFFIXES).map((suffix) => `${coverPath}.${suffix}`);

/** Scales a cover down to `pixels` on its shorter side. Returns null when it cannot be decoded or is already small enough. */
export type ResizeCover = (cover: Buffer, pixels: number) => Buffer | null;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Returns a function giving a cover's thumbnail of a size, made on first use and kept on disk. It gives
 * null when the cover should be shown as is.
 */
export function makeThumbnails(resize: ResizeCover): (coverPath: string, size: ThumbnailSize) => Promise<Buffer | null> {
  /** By thumbnail file, as are the maps below. */
  const inFlight = new Map<string, Promise<Buffer | null>>();
  /** Modification time of each cover that needs no thumbnail of a size, so it is not decoded again on every request. */
  const skipped = new Map<string, number>();
  /** Settles when the covers queued so far have been resized. */
  let resized: Promise<unknown> = Promise.resolve();

  /**
   * `resize` blocks the thread it runs on: about 10 ms for a usual cover, up to 100 ms for a 3000 px
   * one, and a grid asks for dozens at once. They are resized one at a time, and the event loop gets a
   * turn after each, so IPC and player events wait for one cover at most.
   */
  const resizeInTurn = (coverPath: string, size: ThumbnailSize): Promise<Buffer | null> => {
    const thumbnail = resized.then(async () => resize(await readFile(coverPath), THUMBNAIL_PIXELS[size]));
    resized = thumbnail.then(nextTurn, nextTurn);
    return thumbnail;
  };

  const load = async (coverPath: string, size: ThumbnailSize, thumbnailPath: string) => {
    const [cover, cached] = await Promise.all([stat(coverPath), stat(thumbnailPath).catch(() => null)]);
    // A cover downloaded again is newer than its thumbnail.
    if (cached && cached.mtimeMs >= cover.mtimeMs) return readFile(thumbnailPath);
    if (skipped.get(thumbnailPath) === cover.mtimeMs) return null;

    const thumbnail = await resizeInTurn(coverPath, size);
    if (!thumbnail) {
      skipped.set(thumbnailPath, cover.mtimeMs);
      return null;
    }

    // Renamed into place, so a crash cannot leave half a thumbnail behind.
    const temporaryPath = `${thumbnailPath}.tmp`;
    await writeFile(temporaryPath, thumbnail);
    await rename(temporaryPath, thumbnailPath);
    return thumbnail;
  };

  return (coverPath, size) => {
    const thumbnailPath = thumbnailPathOf(coverPath, size);
    const current = inFlight.get(thumbnailPath);
    if (current) return current;

    const pending = load(coverPath, size, thumbnailPath).finally(() => inFlight.delete(thumbnailPath));
    inFlight.set(thumbnailPath, pending);
    return pending;
  };
}
