import { readFile, rename, stat, writeFile } from "node:fs/promises";

/** Shorter side of a thumbnail in pixels: a grid tile is about 200 px wide, doubled for a 2x display. */
export const THUMBNAIL_SIZE = 400;

/** Thumbnails sit next to their cover, so removing a cover can remove its thumbnail. */
export const thumbnailPathOf = (coverPath: string): string => `${coverPath}.thumb`;

/** Scales a cover down. Returns null when it cannot be decoded or is already small enough. */
export type ResizeCover = (cover: Buffer) => Buffer | null;

/** Returns a function giving a cover's thumbnail, made on first use and kept on disk. It gives null when the cover should be shown as is. */
export function makeThumbnails(resize: ResizeCover): (coverPath: string) => Promise<Buffer | null> {
  const inFlight = new Map<string, Promise<Buffer | null>>();
  /** Modification time of each cover that needs no thumbnail, so it is not decoded again on every request. */
  const skipped = new Map<string, number>();

  const load = async (coverPath: string) => {
    const thumbnailPath = thumbnailPathOf(coverPath);
    const [cover, cached] = await Promise.all([stat(coverPath), stat(thumbnailPath).catch(() => null)]);
    // A cover downloaded again after a repair is newer than its thumbnail.
    if (cached && cached.mtimeMs >= cover.mtimeMs) return readFile(thumbnailPath);
    if (skipped.get(coverPath) === cover.mtimeMs) return null;

    const thumbnail = resize(await readFile(coverPath));
    if (!thumbnail) {
      skipped.set(coverPath, cover.mtimeMs);
      return null;
    }

    // Renamed into place, so a crash cannot leave half a thumbnail behind.
    const temporaryPath = `${thumbnailPath}.tmp`;
    await writeFile(temporaryPath, thumbnail);
    await rename(temporaryPath, thumbnailPath);
    return thumbnail;
  };

  return (coverPath) => {
    const current = inFlight.get(coverPath);
    if (current) return current;

    const pending = load(coverPath).finally(() => inFlight.delete(coverPath));
    inFlight.set(coverPath, pending);
    return pending;
  };
}
