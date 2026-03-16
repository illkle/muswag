import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import SubsonicAPI, { type AlbumID3 } from "subsonic-api";

import { getAlbumCoverExtension } from "./utils.js";

function encodeAlbumCoverFilename(id: string): string {
  return encodeURIComponent(id);
}

export async function removeAlbumCoverFiles(coverArtDir: string, albumId: string): Promise<void> {
  await mkdir(coverArtDir, { recursive: true });
  const filenamePrefix = `${encodeAlbumCoverFilename(albumId)}.`;
  const entries = await readdir(coverArtDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
      .map((entry) => rm(join(coverArtDir, entry.name), { force: true })),
  );
}

async function fetchAlbumCoverArt(api: SubsonicAPI, album: AlbumID3, coverArtDir: string): Promise<string | null> {
  await mkdir(coverArtDir, { recursive: true });

  if (!album.coverArt) {
    await removeAlbumCoverFiles(coverArtDir, album.id);
    return null;
  }

  const response = await api.getCoverArt({ id: album.coverArt, size: 1000 });
  if (!response.ok) {
    throw new Error(`Fetching album cover failed for ${album.id}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Fetching album cover failed for ${album.id}: empty response body`);
  }

  const extension = getAlbumCoverExtension(response.headers.get("content-type"));
  const outputPath = join(coverArtDir, `${encodeAlbumCoverFilename(album.id)}${extension}`);
  await removeAlbumCoverFiles(coverArtDir, album.id);
  await writeFile(outputPath, bytes);

  return outputPath;
}

export async function fetchAlbumCoverArtWithRetry(api: SubsonicAPI, album: AlbumID3, coverArtDir: string) {
  if (!album.coverArt) {
    await removeAlbumCoverFiles(coverArtDir, album.id);
    return null;
  }

  let lastCause: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchAlbumCoverArt(api, album, coverArtDir);
    } catch (cause) {
      lastCause = cause;
    }
  }

  console.warn("Album cover fetch failed; preserving existing cached art if present.", {
    albumId: album.id,
    cause: lastCause,
  });
  return undefined;
}
