import { cn } from "#/lib/utils";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";
import type { ReactNode } from "react";

/** Edge of the square artwork, and the height of the header block it sits in. */
const HEADER_HEIGHT = 200;

/** Room a virtualized list has to reserve so its first row clears the floating header. */
export const DETAIL_TOP_PADDING = HEADER_HEIGHT + TOP_HEIGHT + 16;
export const DETAIL_BOTTOM_PADDING = PLAYER_HEIGHT + 16;

/**
 * The header of a detail page (album, artist, playlist). It is absolutely positioned so it scrolls
 * away with the virtualized list underneath it rather than sitting in a fixed bar of its own.
 */
export function DetailHeader({
  art,
  title,
  children,
  className,
}: {
  art: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** For aligning the artwork with whatever list sits below it, which pads its own rows. */
  className?: string;
}) {
  return (
    <header
      className={cn(
        "absolute top-0 mt-(--top-height) grid h-(--header-height) gap-4 px-4 md:grid-cols-[var(--header-height)_minmax(0,1fr)]",
        className,
      )}
      style={{ "--header-height": HEADER_HEIGHT + "px" } as React.CSSProperties}
    >
      {art}

      <div className="flex min-w-0 flex-col gap-1 self-end">
        <h1 className="line-clamp-2 text-2xl font-semibold tracking-tight md:text-4xl">{title}</h1>
        {children}
      </div>
    </header>
  );
}

/** Stand-in artwork for things that have no cover, matching the empty state of `AlbumCover`. */
export function DetailHeaderPlaceholder({ icon, className }: { icon: ReactNode; className?: string }) {
  return (
    <div className={cn("flex aspect-square w-full items-center justify-center rounded border border-border bg-muted", className)}>
      <span className="text-muted-foreground/40 [&_svg]:size-16">{icon}</span>
    </div>
  );
}
