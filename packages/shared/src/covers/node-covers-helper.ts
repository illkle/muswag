import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoverArtFileSystem } from "./covers-helper.js";

const COVER_EXTENSIONS = [".jpg", ".png", ".webp", ".gif", ".avif"];

function encodeCoverFilename(key: string): string {
  return encodeURIComponent(key);
}

export function createNodeCoverArtFileSystem(coverArtDir: string): CoverArtFileSystem {
  async function removeCoverFiles(key: string): Promise<void> {
    const filename = encodeCoverFilename(key);
    await Promise.all(COVER_EXTENSIONS.map((extension) => rm(join(coverArtDir, `${filename}${extension}`), { force: true })));
  }

  return {
    removeCoverFiles,
    async writeCoverFile(key: string, extension: string, bytes: Uint8Array): Promise<string> {
      await mkdir(coverArtDir, { recursive: true });
      const outputPath = join(coverArtDir, `${encodeCoverFilename(key)}${extension}`);
      await removeCoverFiles(key);
      await writeFile(outputPath, bytes);
      return outputPath;
    },
    async listCoverFiles(): Promise<string[]> {
      await mkdir(coverArtDir, { recursive: true });
      const entries = await readdir(coverArtDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).map((entry) => join(coverArtDir, entry.name));
    },
    removeCoverFile: (path) => rm(path, { force: true }),
  };
}
