interface SyncEventStart {
  type: "start";
  date: string;
}

interface SyncEventUpdate {
  type: "update";
  process: "Albums";
  count: number;
}

interface SyncEventEnd {
  type: "end";
  date: string;
}

export type SyncEvent = SyncEventStart | SyncEventEnd | SyncEventUpdate;

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
