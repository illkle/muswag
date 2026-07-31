import SubsonicAPI from "@muswag/subsonic-api";

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

  const extension = getAlbumCoverExtension(response.headers.get("content-type"));
  return fileSystem.writeCoverFile(key, extension, bytes);
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
