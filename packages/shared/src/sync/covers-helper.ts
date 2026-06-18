import SubsonicAPI from "subsonic-api";

import type { CoverArtStore } from "./utils.js";
import { getAlbumCoverExtension } from "./utils.js";

export interface CoverArtFileSystem {
  removeCoverFiles(albumId: string): Promise<void>;
  writeCoverFile(albumId: string, extension: string, bytes: Uint8Array): Promise<string>;
}

async function fetchAlbumCoverArt(
  api: SubsonicAPI,
  albumId: string,
  coverArtId: string,
  fileSystem: CoverArtFileSystem,
): Promise<string | null> {
  const response = await api.getCoverArt({ id: coverArtId, size: 1000 });
  if (!response.ok) {
    throw new Error(`Fetching album cover failed for ${albumId}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Fetching album cover failed for ${albumId}: empty response body`);
  }

  const extension = getAlbumCoverExtension(response.headers.get("content-type"));
  return fileSystem.writeCoverFile(albumId, extension, bytes);
}

export interface SubsonicCoverArtStoreOptions {
  url: string;
  username: string;
  password: string;
  fileSystem: CoverArtFileSystem;
}

/**
 * Creates a CoverArtStore backed by injectable cover file operations and a
 * Subsonic API connection.
 */
export function createCoverArtStore(options: SubsonicCoverArtStoreOptions): CoverArtStore {
  const api = new SubsonicAPI({
    url: options.url,
    auth: {
      username: options.username,
      password: options.password,
    },
  });
  const { fileSystem } = options;

  return {
    async fetch(albumId: string, coverArtId: string | null): Promise<string | null | undefined> {
      if (!coverArtId) {
        await fileSystem.removeCoverFiles(albumId);
        return null;
      }

      let lastCause: unknown;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await fetchAlbumCoverArt(api, albumId, coverArtId, fileSystem);
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
      await fileSystem.removeCoverFiles(albumId);
    },
  };
}
