import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoverArtFileSystem } from "./covers-helper.js";

function encodeAlbumCoverFilename(id: string): string {
  return encodeURIComponent(id);
}

export function createNodeCoverArtFileSystem(coverArtDir: string): CoverArtFileSystem {
  async function removeCoverFiles(albumId: string): Promise<void> {
    await mkdir(coverArtDir, { recursive: true });
    const filenamePrefix = `${encodeAlbumCoverFilename(albumId)}.`;
    const entries = await readdir(coverArtDir, { withFileTypes: true });

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
        .map((entry) => rm(join(coverArtDir, entry.name), { force: true })),
    );
  }

  return {
    removeCoverFiles,
    async writeCoverFile(albumId: string, extension: string, bytes: Uint8Array): Promise<string> {
      await mkdir(coverArtDir, { recursive: true });
      const outputPath = join(coverArtDir, `${encodeAlbumCoverFilename(albumId)}${extension}`);
      await removeCoverFiles(albumId);
      await writeFile(outputPath, bytes);

      return outputPath;
    },
  };
}
