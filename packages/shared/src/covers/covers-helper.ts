/*

import SubsonicAPI from "../subsonic-api.js";

export interface CoverArtFileSystem {
  removeCoverFiles(key: string): Promise<void>;
  writeCoverFile(key: string, extension: string, bytes: Uint8Array): Promise<string>;
  listCoverFiles?(): Promise<string[]>;
  removeCoverFile?(path: string): Promise<void>;
}

async function fetchCoverArt(api: SubsonicAPI, key: string, coverArtId: string, fileSystem: CoverArtFileSystem): Promise<string | null> {
  const response = await api.getCoverArt({ id: coverArtId, size: 1000 });
  if (!response.ok) {
    throw new Error(`Fetching cover failed for ${key}: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`Fetching cover failed for ${key}: empty response body`);
  }

  const extension = detectCoverExtension(bytes);
  if (!extension) {
    throw new Error(`Fetching cover failed for ${key}: response is not a supported image`);
  }
  return fileSystem.writeCoverFile(key, extension, bytes);
}

function detectCoverExtension(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return ".png";
  }
  const header = String.fromCharCode(...bytes.subarray(0, 32));
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return ".gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return ".webp";
  if (header.slice(4, 8) === "ftyp" && (header.includes("avif", 8) || header.includes("avis", 8))) return ".avif";
  return null;
}

export interface SubsonicCoverArtStoreOptions {
  url: string;
  username: string;
  password: string;
  fileSystem: CoverArtFileSystem;
}

export function createCoverArtStore(options: SubsonicCoverArtStoreOptions): CoverArtStore {
  const api = new SubsonicAPI({
    url: options.url,
    auth: { username: options.username, password: options.password },
  });
  const { fileSystem } = options;

  return {
    async fetch(key: string, coverArtId: string | null): Promise<string | null | undefined> {
      if (!coverArtId) {
        await fileSystem.removeCoverFiles(key);
        return null;
      }

      let lastCause: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await fetchCoverArt(api, key, coverArtId, fileSystem);
        } catch (cause) {
          lastCause = cause;
        }
      }

      console.warn("Cover fetch failed; preserving existing cached art if present.", { key, cause: lastCause });
      return undefined;
    },
    remove: (key) => fileSystem.removeCoverFiles(key),
    ...(fileSystem.listCoverFiles ? { list: () => fileSystem.listCoverFiles!() } : {}),
    ...(fileSystem.removeCoverFile ? { removePath: (path: string) => fileSystem.removeCoverFile!(path) } : {}),
  };
}

export interface CoverArtStore {
  fetch(key: string, coverArtId: string | null): Promise<string | null | undefined>;
  remove(key: string): Promise<void>;
  list?: () => Promise<string[]>;
  removePath?: (path: string) => Promise<void>;
}

export function getAlbumCoverExtension(contentType: string | null): string {
  if (!contentType) return ".jpg";

  switch (contentType.split(";")[0]?.trim().toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/avif":
      return ".avif";
    default:
      return ".jpg";
  }
}
*/
