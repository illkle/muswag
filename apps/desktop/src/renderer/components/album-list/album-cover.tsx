import { viaDevBridge } from "#/data/dev-bridge";
import { cn } from "#/lib/utils";
import type { CoverSize } from "#shared/cover";
import type { CoverTarget } from "@muswag/model";
import { useEffect, useState } from "react";

/** A little longer than main remembers a failed download, so the next request starts a new one. */
const RETRY_FAILED_COVER_AFTER_MS = 70_000;

/** What a cover without an image shows instead: the name of what it is of, and under it, such as an album's artist. */
export type CoverPlaceholder = { title: string; subtitle?: string | null | undefined };

/**
 * An image the browser loads once it is about to be seen and decodes off the main thread, over a
 * placeholder while there is none. Where there is no image to load, or it could not be loaded, the
 * placeholder is set with `placeholder`'s names, sized to the cover: the first letter of the title in
 * an icon, and the title over the subtitle in anything larger.
 */
export function AlbumCover({
  size = "full",
  target,
  placeholder,
  className,
}: {
  /** Loads a copy scaled down to about what the cover is shown at: an image takes memory for the size it is loaded at. */
  size?: CoverSize | undefined;
  target?: CoverTarget | undefined;
  placeholder?: CoverPlaceholder | undefined;
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

  const showsImage = coverSrc !== null && coverSrc !== failedSrc;
  // While the image loads, the placeholder is left plain rather than set and then covered.
  const named = !showsImage && placeholder?.title ? placeholder : null;

  return (
    // The cover is the container the placeholder's type is sized by.
    <div className={cn("@container relative aspect-square overflow-hidden rounded", className)}>
      {showsImage && (
        <img src={coverSrc} alt={`cover art`} className="relative z-10 size-full animate-in object-cover fade-in-0" decoding="async" loading="lazy" onError={() => setFailedSrc(coverSrc)} />
      )}
      {/* Rounded as the cover is, so that its border follows a round cover rather than being cut off by it. */}
      <div className="absolute top-0 flex size-full flex-col rounded-[inherit] border border-border bg-muted select-none" aria-hidden>
        {named && size === "icon" ? (
          <span className="m-auto text-[45cqw] leading-none font-semibold text-muted-foreground uppercase">{[...named.title.trim()][0]}</span>
        ) : named ? (
          <div className="mt-auto flex min-w-0 flex-col gap-[3cqw] p-[8cqw] text-left">
            <span className="line-clamp-4 text-[11cqw] leading-[1.05] font-semibold tracking-tight [overflow-wrap:anywhere] text-foreground/75">{named.title}</span>
            {named.subtitle ? <span className="truncate text-[7cqw] leading-tight text-muted-foreground">{named.subtitle}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Main serves a cover by what it is of, downloading it first when it has to
 * (`main/cover-protocol.ts`). A browser cannot load `muswag-cover:`, so there the dev bridge serves it.
 * The address carries the id the server gives the image, so that a changed cover is loaded again.
 */
function toCoverArtUrl(type: CoverTarget["type"], id: string, coverArtId: string, size: CoverSize): string {
  const cover = `${type}/${encodeURIComponent(id)}?v=${encodeURIComponent(coverArtId)}${size === "full" ? "" : `&size=${size}`}`;
  return viaDevBridge ? `/__bridge/cover/${cover}` : `muswag-cover://${cover}`;
}
