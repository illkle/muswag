import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNodeCoverArtFileSystem } from "#core/sync-node";

describe("node cover art filesystem", () => {
  it("publishes versioned files and removes only files belonging to the requested key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muswag-covers-"));
    try {
      const fileSystem = createNodeCoverArtFileSystem(directory);
      const firstPath = await fileSystem.writeCoverFile("album:a", ".jpg", Uint8Array.of(1, 2, 3));
      const adjacentKeyPath = await fileSystem.writeCoverFile("album:a.b", ".jpg", Uint8Array.of(4, 5, 6));

      expect(firstPath).not.toBe(adjacentKeyPath);
      expect(await readFile(firstPath)).toEqual(Buffer.from([1, 2, 3]));
      expect(await readFile(adjacentKeyPath)).toEqual(Buffer.from([4, 5, 6]));

      await fileSystem.removeCoverFiles("album:a");

      await expect(access(firstPath)).rejects.toThrow();
      await expect(access(adjacentKeyPath)).resolves.toBeUndefined();
      expect(await fileSystem.listCoverFiles?.()).toEqual([adjacentKeyPath]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
