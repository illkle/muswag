import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MiniFs } from "@muswag/backend";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coverDirectoryOf, MiniFsLive } from "./platform";

describe("MiniFsLive", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "muswag-platform-"));
  });
  afterEach(() => rm(base, { recursive: true, force: true }));

  const run = <A, E>(effect: Effect.Effect<A, E, MiniFs>) => Effect.runPromise(effect.pipe(Effect.provide(MiniFsLive(base))));

  it("lists the files a directory holds, and nothing of one that is not there", async () => {
    // A library kept elsewhere has a cover directory inside the app's, which the app's sweep must not take for a file.
    await mkdir(join(base, "covers", "library-0123456789ab"), { recursive: true });
    await writeFile(join(base, "covers", "album_3a_a"), "");
    await writeFile(join(base, "covers", "album_3a_a.thumb"), "");

    expect([...(await run(MiniFs.use((fs) => fs.list("covers"))))].sort()).toEqual(["album_3a_a", "album_3a_a.thumb"]);
    expect(await run(MiniFs.use((fs) => fs.list("missing")))).toEqual([]);
  });

  it("lists nothing outside the app data directory", async () => {
    await expect(run(MiniFs.use((fs) => fs.list("..")))).rejects.toThrow("Failed to list ..");
  });
});

describe("coverDirectoryOf", () => {
  it("keeps the covers of the app's own library in the cover directory", () => {
    expect(coverDirectoryOf("/data/muswag/library.db", "/data/muswag")).toBe("covers");
  });

  it("gives each library kept elsewhere a directory of its own inside it", () => {
    const main = coverDirectoryOf("/src/muswag/apps/desktop/dev-library.db", "/data/muswag");
    const worktree = coverDirectoryOf("/src/worktree/apps/desktop/dev-library.db", "/data/muswag");

    expect(main).toMatch(/^covers[\\/]library-[0-9a-f]{12}$/);
    expect(worktree).toMatch(/^covers[\\/]library-[0-9a-f]{12}$/);
    expect(main).not.toBe(worktree);
    expect(coverDirectoryOf("/src/muswag/apps/desktop/dev-library.db", "/data/muswag")).toBe(main);
  });
});
