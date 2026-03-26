/**
 * Generic interface for cover art storage operations.
 * Implementations handle fetching, caching, and cleanup of album artwork.
 *
 * - `fetch` returns the local path to the saved file, `null` if the album has
 *   no cover art, or `undefined` if the fetch failed (preserves existing cache).
 * - `remove` deletes any cached cover art for the given album.
 */
export interface CoverArtStore {
  fetch(albumId: string, coverArtId: string | null): Promise<string | null | undefined>;
  remove(albumId: string): Promise<void>;
}

export function getAlbumCoverExtension(contentType: string | null): string {
  if (!contentType) {
    return ".jpg";
  }

  const normalized = contentType.split(";")[0]?.trim().toLowerCase();

  switch (normalized) {
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
