import { readFile } from "node:fs/promises";

import type { ReadCoverColours } from "@muswag/backend";
import type { CoverColours } from "@muswag/model";
import { nativeImage } from "electron";

import { COLOURS_SAMPLE_SIZE, coverColours, NO_COVER_COLOURS } from "#shared/cover-colours";
import { resolveInside } from "./app/platform";
import type { CoverThumbnails } from "./cover-protocol";

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** `nativeImage` decodes only JPEG and PNG: a cover in another format has no colours. */
function coloursOf(cover: Buffer): CoverColours {
  const image = nativeImage.createFromBuffer(cover);
  if (image.isEmpty()) return NO_COVER_COLOURS;
  const sample = image.resize({ width: COLOURS_SAMPLE_SIZE, height: COLOURS_SAMPLE_SIZE, quality: "good" });
  return coverColours({ data: sample.toBitmap(), order: "bgra" });
}

/**
 * Reads the colours of cover files, their paths relative to `base`. Decoding a cover, scaling it down and
 * reducing its colours blocks the thread for tens of milliseconds, and a grid shows dozens of covers at once:
 * they are read one at a time, and the event loop gets a turn after each.
 *
 * They are read from the cover's thumbnail, the one the grid shows, or from the cover where it is small enough
 * to have none. Material's score can turn on how a cover was scaled down: a dark cover's accent may be its red
 * from one copy and a near-black from another, and the colours were chosen looking at the thumbnail's.
 */
export function readCoverColoursIn(base: string, thumbnailOf: CoverThumbnails): ReadCoverColours {
  /** Settles when the covers queued so far have been read. */
  let read: Promise<unknown> = Promise.resolve();

  return async (coverPath) => {
    const absolutePath = resolveInside(base, coverPath);
    const cover = (await thumbnailOf(absolutePath, "thumbnail")) ?? (await readFile(absolutePath));
    const colours = read.then(() => coloursOf(cover));
    read = colours.then(nextTurn, nextTurn);
    return colours;
  };
}
