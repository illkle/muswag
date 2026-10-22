import { CoverPaletteSwatches } from "#/components/cover-palette-debug";
import { paletteDebug } from "#/library/cover-palette";
import { toCoverArtUrl } from "#/library/cover-url";
import { cn } from "#/lib/utils";
import type { CoverSize } from "#shared/cover";
import type { CoverTarget } from "@muswag/model";
import { useStore } from "@tanstack/react-store";
import { useEffect, useState } from "react";

/** A little longer than main remembers a failed download, so the next request starts a new one. */
const RETRY_FAILED_COVER_AFTER_MS = 70_000;

/** An image the browser loads once it is about to be seen and decodes off the main thread, over a placeholder while there is none. */
export function AlbumCover({
  size = "full",
  target,
  className,
}: {
  /** Loads a copy scaled down to about what the cover is shown at: an image takes memory for the size it is loaded at. */
  size?: CoverSize | undefined;
  target?: CoverTarget | undefined;
  className?: string | undefined;
}) {
  const coverSrc = target?.coverArtId ? toCoverArtUrl(target.type, target.id, target.coverArtId, size) : null;
  /** The address that did not load. Main keeps a failed download for a minute, so it is asked for again after that. */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  useEffect(() => {
    if (failedSrc === null) return;
    const retry = setTimeout(() => setFailedSrc(null), RETRY_FAILED_COVER_AFTER_MS);
    return () => clearTimeout(retry);
  }, [failedSrc]);
  // List rows' covers are too small to draw the colours over.
  const showPalette = useStore(paletteDebug) && import.meta.env.DEV && size !== "icon";

  return (
    <div className={cn("relative aspect-square overflow-hidden rounded", className)}>
      {coverSrc && coverSrc !== failedSrc && (
        <img src={coverSrc} alt={`cover art`} className="relative z-10 size-full animate-in object-cover fade-in-0" decoding="async" loading="lazy" onError={() => setFailedSrc(coverSrc)} />
      )}
      <div className="absolute top-0 size-full border border-border bg-muted"> </div>
      {showPalette && target?.coverArtId ? <CoverPaletteSwatches target={target} /> : null}
    </div>
  );
}
