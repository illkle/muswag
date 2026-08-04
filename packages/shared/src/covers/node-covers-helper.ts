import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoverArtFileSystem } from "./covers-helper.js";

const COVER_EXTENSIONS = [".jpg", ".png", ".webp", ".gif", ".avif"];
const VERSION_SEPARATOR = "@";

function encodeCoverFilename(key: string): string {
  return encodeURIComponent(key);
}

export function createNodeCoverArtFileSystem(coverArtDir: string): CoverArtFileSystem {
  async function removeCoverFiles(key: string): Promise<void> {
    await mkdir(coverArtDir, { recursive: true });
    const prefix = `${encodeCoverFilename(key)}${VERSION_SEPARATOR}`;
    const entries = await readdir(coverArtDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => rm(join(coverArtDir, entry.name), { force: true })));

    // Remove files written by versions that used non-versioned cache names.
    const legacyFilename = encodeCoverFilename(key);
    await Promise.all(COVER_EXTENSIONS.map((extension) => rm(join(coverArtDir, `${legacyFilename}${extension}`), { force: true })));
  }

  return {
    removeCoverFiles,
    async writeCoverFile(key: string, extension: string, bytes: Uint8Array): Promise<string> {
      await mkdir(coverArtDir, { recursive: true });
      const revision = randomUUID();
      const filename = `${encodeCoverFilename(key)}${VERSION_SEPARATOR}${revision}`;
      const outputPath = join(coverArtDir, `${filename}${extension}`);
      const temporaryPath = join(coverArtDir, `${filename}.tmp`);
      try {
        await writeFile(temporaryPath, bytes, { flag: "wx" });
        await rename(temporaryPath, outputPath);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
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
