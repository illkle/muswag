import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeThumbnails, THUMBNAIL_PIXELS, thumbnailPathOf, thumbnailPathsOf, type ResizeCover } from "./cover-thumbnails";

let directory: string;
let coverPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "muswag-thumbnails-"));
  coverPath = join(directory, "cover.jpg");
  await writeFile(coverPath, "cover");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const shrink = () => vi.fn<ResizeCover>((cover) => Buffer.from(`small ${cover.toString()}`));

describe("makeThumbnails", () => {
  it("makes a thumbnail once and reads it from disk afterwards", async () => {
    const resize = shrink();

    expect((await makeThumbnails(resize)(coverPath, "thumbnail"))?.toString()).toBe("small cover");
    expect((await readFile(thumbnailPathOf(coverPath, "thumbnail"))).toString()).toBe("small cover");
    // A new instance stands for the next run of the app.
    expect((await makeThumbnails(resize)(coverPath, "thumbnail"))?.toString()).toBe("small cover");
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("makes each size from the cover, into a file of its own", async () => {
    const resize = vi.fn<ResizeCover>((cover, pixels) => Buffer.from(`${pixels} ${cover.toString()}`));
    const thumbnailOf = makeThumbnails(resize);

    expect((await thumbnailOf(coverPath, "thumbnail"))?.toString()).toBe(`${THUMBNAIL_PIXELS.thumbnail} cover`);
    expect((await thumbnailOf(coverPath, "icon"))?.toString()).toBe(`${THUMBNAIL_PIXELS.icon} cover`);
    expect((await readFile(thumbnailPathOf(coverPath, "icon"))).toString()).toBe(`${THUMBNAIL_PIXELS.icon} cover`);
    expect(thumbnailPathsOf(coverPath).sort()).toEqual([thumbnailPathOf(coverPath, "icon"), thumbnailPathOf(coverPath, "thumbnail")].sort());
  });

  it("resizes a cover once when it is requested several times at once", async () => {
    const resize = shrink();
    const thumbnailOf = makeThumbnails(resize);

    await Promise.all([thumbnailOf(coverPath, "thumbnail"), thumbnailOf(coverPath, "thumbnail"), thumbnailOf(coverPath, "thumbnail")]);

    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("resizes one cover at a time and lets the event loop run after each", async () => {
    const coverPaths = await Promise.all(
      ["a", "b", "c"].map(async (name) => {
        const path = join(directory, name);
        await writeFile(path, name);
        return path;
      }),
    );
    const events: string[] = [];
    // The timer stands for the IPC and player events that wait for the loop.
    const resize: ResizeCover = (cover) => {
      events.push("resize");
      setTimeout(() => events.push("turn"), 0);
      return cover;
    };

    const thumbnailOf = makeThumbnails(resize);
    await Promise.all(coverPaths.map((path) => thumbnailOf(path, "thumbnail")));

    expect(events.slice(0, 5)).toEqual(["resize", "turn", "resize", "turn", "resize"]);
  });

  it("makes the thumbnail again when the cover was replaced", async () => {
    const thumbnailOf = makeThumbnails(shrink());
    await thumbnailOf(coverPath, "thumbnail");

    await writeFile(coverPath, "replaced");
    const later = new Date(Date.now() + 60_000);
    await utimes(coverPath, later, later);

    expect((await thumbnailOf(coverPath, "thumbnail"))?.toString()).toBe("small replaced");
  });

  it("gives null and decodes only once for a cover that needs no thumbnail", async () => {
    const resize = vi.fn<ResizeCover>(() => null);
    const thumbnailOf = makeThumbnails(resize);

    expect(await thumbnailOf(coverPath, "thumbnail")).toBeNull();
    expect(await thumbnailOf(coverPath, "thumbnail")).toBeNull();

    expect(resize).toHaveBeenCalledTimes(1);
    expect(existsSync(thumbnailPathOf(coverPath, "thumbnail"))).toBe(false);
  });

  it("fails for a cover that is missing", async () => {
    await expect(makeThumbnails(shrink())(join(directory, "missing.jpg"), "thumbnail")).rejects.toThrow("ENOENT");
  });
});
