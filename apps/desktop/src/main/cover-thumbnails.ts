import { readFile, rename, stat, writeFile } from "node:fs/promises";

/** Shorter side of a thumbnail in pixels: a grid tile is about 200 px wide, doubled for a 2x display. */
export const THUMBNAIL_SIZE = 400;

/** Thumbnails sit next to their cover, so removing a cover can remove its thumbnail. */
export const thumbnailPathOf = (coverPath: string): string => `${coverPath}.thumb`;

/** Scales a cover down. Returns null when it cannot be decoded or is already small enough. */
export type ResizeCover = (cover: Buffer) => Buffer | null;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Returns a function giving a cover's thumbnail, made on first use and kept on disk. It gives null when the cover should be shown as is. */
export function makeThumbnails(resize: ResizeCover): (coverPath: string) => Promise<Buffer | null> {
  const inFlight = new Map<string, Promise<Buffer | null>>();
  /** Modification time of each cover that needs no thumbnail, so it is not decoded again on every request. */
  const skipped = new Map<string, number>();
  /** Settles when the covers queued so far have been resized. */
  let resized: Promise<unknown> = Promise.resolve();

  /**
   * `resize` blocks the thread it runs on: about 10 ms for a usual cover, up to 100 ms for a 3000 px
   * one, and a grid asks for dozens at once. They are resized one at a time, and the event loop gets a
   * turn after each, so IPC and player events wait for one cover at most.
   */
  const resizeInTurn = (coverPath: string): Promise<Buffer | null> => {
    const thumbnail = resized.then(async () => resize(await readFile(coverPath)));
    resized = thumbnail.then(nextTurn, nextTurn);
    return thumbnail;
  };

  const load = async (coverPath: string) => {
    const thumbnailPath = thumbnailPathOf(coverPath);
    const [cover, cached] = await Promise.all([stat(coverPath), stat(thumbnailPath).catch(() => null)]);
    // A cover downloaded again is newer than its thumbnail.
    if (cached && cached.mtimeMs >= cover.mtimeMs) return readFile(thumbnailPath);
    if (skipped.get(coverPath) === cover.mtimeMs) return null;

    const thumbnail = await resizeInTurn(coverPath);
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
