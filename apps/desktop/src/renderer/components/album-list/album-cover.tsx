import { viaDevBridge } from "#/data/dev-bridge";
import { cn } from "#/lib/utils";
import type { CoverTarget } from "@muswag/model";
import { startTransition, useEffect, useState } from "react";

/** A little longer than main remembers a failed download, so the next request starts a new one. */
const RETRY_FAILED_COVER_AFTER_MS = 70_000;

export function AlbumCover({
  instantLoad = false,
  thumbnail = false,
  target,
  className,
}: {
  instantLoad?: boolean | undefined;
  /** Loads a scaled-down copy, for covers shown small. */
  thumbnail?: boolean | undefined;
  target?: CoverTarget | undefined;
  className?: string | undefined;
}) {
  const coverSrc = target?.coverArtId ? toCoverArtUrl(target.type, target.id, target.coverArtId, thumbnail) : null;
  /** The address that did not load. Main keeps a failed download for a minute, so it is asked for again after that. */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    if (failedSrc === null) return;
    const retry = setTimeout(() => setFailedSrc(null), RETRY_FAILED_COVER_AFTER_MS);
    return () => clearTimeout(retry);
  }, [failedSrc]);

  const [loadImage, setLoadImage] = useState(instantLoad);

  useEffect(() => {
    const t = setTimeout(() => {
      startTransition(() => {
        setLoadImage(true);
      });
    }, 50);

    return () => {
      clearTimeout(t);
    };
  }, []);

  return (
    <div className={cn("relative aspect-square overflow-hidden rounded", className)}>
      {coverSrc && coverSrc !== failedSrc && loadImage && (
        <img src={coverSrc} alt={`cover art`} className="relative z-10 size-full animate-in object-cover fade-in-0" decoding="async" loading="lazy" onError={() => setFailedSrc(coverSrc)} />
      )}
      <div className="absolute top-0 size-full border border-border bg-muted"> </div>
    </div>
  );
}

/**
 * Main serves a cover by what it is of, downloading it first when it has to
 * (`main/cover-protocol.ts`). A browser cannot load `muswag-cover:`, so there the dev bridge serves it.
 * The address carries the id the server gives the image, so that a changed cover is loaded again.
 */
function toCoverArtUrl(type: CoverTarget["type"], id: string, coverArtId: string, thumbnail: boolean): string {
  const cover = `${type}/${encodeURIComponent(id)}?v=${encodeURIComponent(coverArtId)}${thumbnail ? "&thumbnail" : ""}`;
  return viaDevBridge ? `/__bridge/cover/${cover}` : `muswag-cover://${cover}`;
}
