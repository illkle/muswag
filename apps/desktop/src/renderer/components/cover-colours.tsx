import { eq, useLiveQuery } from "@tanstack/react-db";
import type { CoverColours } from "@muswag/model";

import { db } from "#/data/library";
import { cn } from "#/lib/utils";
import { foregroundOn } from "#shared/cover-colours";

/**
 * Gives what is inside the colours of a cover as custom properties: `--cover-accent`, `--cover-glow-1` and
 * `--cover-glow-2`, transparent where the cover has none; a glow colour the cover lacks is its accent. The
 * accent is also `--brand`, which the interface draws its accent with: a cover too grey for one, or whose
 * colours main has not read yet, leaves that to the text colour. The properties fade from one cover's to the
 * next. Takes no room of its own unless a class says otherwise.
 */
export function CoverColoursScope({ colours, className, style, ...props }: { colours: CoverColours | null | undefined } & React.ComponentProps<"div">) {
  const accent = colours?.accent ?? null;
  const [first, second] = colours?.glow ?? [null, null];
  const properties = {
    "--cover-accent": accent ?? "transparent",
    "--cover-glow-1": first ?? accent ?? "transparent",
    "--cover-glow-2": second ?? accent ?? "transparent",
    "--brand": accent ?? "var(--foreground)",
    "--brand-foreground": accent ? foregroundOn(accent) : "var(--background)",
  } as React.CSSProperties;

  return <div {...props} className={cn("cover-colours", className ?? "contents")} style={{ ...properties, ...style }} />;
}

/** The colours of an album's cover, which main reads once it has the cover; null until then and without an album. */
export function useAlbumCoverColours(albumId: string | null): CoverColours | null {
  // The albums are read on demand, so the album is asked for rather than looked up.
  const albumQuery = useLiveQuery({
    queryKey: ["album-cover-colours", albumId],
    query: (q) =>
      albumId === null
        ? undefined
        : q
            .from({ album: db.albums })
            .where(({ album }) => eq(album.id, albumId))
            .findOne(),
  });
  return albumQuery.data?.coverColours ?? null;
}
