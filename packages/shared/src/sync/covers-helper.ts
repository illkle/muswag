import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import SubsonicAPI from "subsonic-api";

import type { CoverArtStore } from "./utils.js";
import { getAlbumCoverExtension } from "./utils.js";

function encodeAlbumCoverFilename(id: string): string {
  return encodeURIComponent(id);
}

async function removeAlbumCoverFiles(coverArtDir: string, albumId: string): Promise<void> {
  await mkdir(coverArtDir, { recursive: true });
  const filenamePrefix = `${encodeAlbumCoverFilename(albumId)}.`;
  const entries = await readdir(coverArtDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
      .map((entry) => rm(join(coverArtDir, entry.name), { force: true })),
  );
}

async function fetchAlbumCoverArt(api: SubsonicAPI, albumId: string, coverArtId: string, coverArtDir: string): Promise<string | null> {
  await mkdir(coverArtDir, { recursive: true });

  const response = await api.getCoverArt({ id: coverArtId, size: 1000 });
  if (!response.ok) {
    throw new Error(`Fetching album cover failed for ${albumId}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Fetching album cover failed for ${albumId}: empty response body`);
  }

  const extension = getAlbumCoverExtension(response.headers.get("content-type"));
  const outputPath = join(coverArtDir, `${encodeAlbumCoverFilename(albumId)}${extension}`);
  await removeAlbumCoverFiles(coverArtDir, albumId);
  await writeFile(outputPath, bytes);

  return outputPath;
}

export interface SubsonicCoverArtStoreOptions {
  url: string;
  username: string;
  password: string;
  coverArtDir: string;
}

/**
 * Creates a CoverArtStore backed by the filesystem and a Subsonic API connection.
 */
export function createCoverArtStore(options: SubsonicCoverArtStoreOptions): CoverArtStore {
  const api = new SubsonicAPI({
    url: options.url,
    auth: {
      username: options.username,
      password: options.password,
    },
  });
  const { coverArtDir } = options;

  return {
    async fetch(albumId: string, coverArtId: string | null): Promise<string | null | undefined> {
      if (!coverArtId) {
        await removeAlbumCoverFiles(coverArtDir, albumId);
        return null;
      }

      let lastCause: unknown;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await fetchAlbumCoverArt(api, albumId, coverArtId, coverArtDir);
        } catch (cause) {
          lastCause = cause;
        }
      }

      console.warn("Album cover fetch failed; preserving existing cached art if present.", {
        albumId,
        cause: lastCause,
      });
      return undefined;
    },

    async remove(albumId: string): Promise<void> {
      await removeAlbumCoverFiles(coverArtDir, albumId);
    },
  };
}
