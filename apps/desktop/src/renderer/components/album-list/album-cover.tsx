import { cn } from "#/lib/utils";
import { CoverArt } from "#/lib/sync-manager";
import type { CoverTarget } from "@muswag/shared";
import { startTransition, useEffect, useState } from "react";

export function AlbumCover({
  coverArtPath,
  instantLoad = false,
  target,
  className,
}: {
  coverArtPath: string | undefined;
  instantLoad?: boolean;
  target?: CoverTarget;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const coverSrc = coverArtPath ? toCoverArtUrl(coverArtPath) : null;

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

  useEffect(() => {
    if (!loadImage || coverArtPath || !target?.coverArtId) return;
    void CoverArt.ensure(target).catch((error: unknown) => {
      console.warn("On-demand cover fetch failed.", { target, error });
    });
  }, [coverArtPath, loadImage, target?.type, target?.id, target?.coverArtId]);

  useEffect(() => setImageFailed(false), [coverArtPath]);

  return (
    <div className={cn("relative aspect-square overflow-hidden rounded", className)}>
      {!imageFailed && coverSrc && loadImage && (
        <img
          src={coverSrc}
          alt={`cover art`}
          className="relative z-10 size-full animate-in object-cover fade-in-0"
          decoding="async"
          loading="lazy"
          onError={() => {
            setImageFailed(true);
          }}
        />
      )}
      <div className="absolute top-0 size-full border border-border bg-muted"> </div>
    </div>
  );
}

function toCoverArtUrl(coverArtPath: string): string {
  return `muswag-cover://local?path=${encodeURIComponent(coverArtPath)}`;
}
