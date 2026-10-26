import { CaretRightIcon } from "@phosphor-icons/react";
import type { LibraryArtist as Artist } from "@muswag/model";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { AlbumCover } from "#/components/album-list/album-cover";
import { scrollMemory } from "#/lib/scroll-memory";
import { cn } from "#/lib/utils";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

const ROW_HEIGHT = 44;
const SECTION_HEIGHT = 48;
const SCROLL_ID = "artist-list";
const FEATURED_OPEN_KEY = "muswag-artist-list-featured-open";

type Row = { type: "artist"; artist: Artist } | { type: "section"; count: number };

/** An artist in the list. Moving the selection draws again only the row it leaves and the one it reaches. */
const ArtistRow = memo(function ArtistRow({ artist, id, selected, onSelect }: { artist: Artist; id: string | undefined; selected: boolean; onSelect: (artistId: string) => void }) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={cn(
        "flex h-full cursor-pointer items-center gap-3 rounded-md px-2 text-sm transition-colors duration-100 select-none hover:bg-muted/50",
        selected && "bg-muted font-medium group-focus-visible/list:ring-2 group-focus-visible/list:ring-ring/60 group-focus-visible/list:ring-inset hover:bg-muted",
      )}
      onClick={() => onSelect(artist.id)}
    >
      <AlbumCover className="size-8 shrink-0 rounded-full" size="icon" target={{ type: "artist", id: artist.id, coverArtId: artist.coverArt ?? null }} placeholder={{ title: artist.name }} />
      <span className="truncate">{artist.name}</span>
    </div>
  );
});

/**
 * The artists to pick from on the artists page: those with albums of their own, and under them the
 * artists only featured on others' albums, which fold away. The list holds the focus, and the arrows,
 * Page Up, Page Down, Home and End pick the artist they move to among those shown.
 */
export function ArtistList({
  artists,
  featured,
  selectedId,
  onSelect,
  className,
}: {
  artists: readonly Artist[];
  featured: readonly Artist[];
  selectedId: string | null;
  onSelect: (artistId: string) => void;
  className?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRowId = useId();
  const initialOffset = scrollMemory.get(SCROLL_ID);

  // Folded until opened, unless the artist picked is one of them.
  const [featuredOpen, setFeaturedOpen] = useState(() => localStorage.getItem(FEATURED_OPEN_KEY) === "true" || featured.some(({ id }) => id === selectedId));
  const toggleFeatured = () => {
    setFeaturedOpen(!featuredOpen);
    localStorage.setItem(FEATURED_OPEN_KEY, String(!featuredOpen));
  };

  const rows = useMemo(
    (): Row[] => [
      ...artists.map((artist) => ({ type: "artist" as const, artist })),
      ...(featured.length > 0 ? [{ type: "section" as const, count: featured.length }] : []),
      ...(featuredOpen ? featured.map((artist) => ({ type: "artist" as const, artist })) : []),
    ],
    [artists, featured, featuredOpen],
  );
  /** The rows of artists, by their index among the rows, which the keyboard goes through. */
  const artistRows = useMemo(() => rows.flatMap((row, index) => (row.type === "artist" ? [index] : [])), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === "section" ? SECTION_HEIGHT : ROW_HEIGHT),
    getItemKey: (index) => {
      const row = rows[index];
      return row?.type === "artist" ? row.artist.id : "featured";
    },
    overscan: 10,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: TOP_HEIGHT,
    paddingEnd: PLAYER_HEIGHT,
    // The top bar and the player lie over the ends of the list.
    scrollPaddingStart: TOP_HEIGHT,
    scrollPaddingEnd: PLAYER_HEIGHT,
    // A scroll is drawn in the next frame rather than at once, which keeps scrolling smooth.
    useFlushSync: false,
  });

  const selectedIndex = rows.findIndex((row) => row.type === "artist" && row.artist.id === selectedId);
  const virtualRows = virtualizer.getVirtualItems();
  const selectedDrawn = virtualRows.some(({ index }) => index === selectedIndex);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((event.currentTarget.clientHeight - TOP_HEIGHT - PLAYER_HEIGHT) / ROW_HEIGHT) - 1);
    const at = artistRows.indexOf(selectedIndex);
    const last = artistRows.length - 1;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, PageDown: at + page, PageUp: at - page, Home: 0, End: last }[event.key];
    if (to === undefined || last < 0) return;
    event.preventDefault();
    const index = artistRows[Math.min(Math.max(to, 0), last)]!;
    const row = rows[index];
    if (row?.type !== "artist") return;
    onSelect(row.artist.id);
    virtualizer.scrollToIndex(index);
  };

  return (
    <div
      ref={scrollRef}
      role="listbox"
      aria-label="Artists"
      aria-activedescendant={selectedDrawn ? selectedRowId : undefined}
      tabIndex={0}
      className={cn("group/list scrollbar h-full overflow-y-auto outline-none", className)}
      onScroll={(event) => scrollMemory.set(SCROLL_ID, event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px` }} className="relative w-full">
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index]!;
          const selected = virtualRow.index === selectedIndex;

          return (
            <div key={virtualRow.key} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 w-full px-2">
              {row.type === "artist" ? (
                <ArtistRow artist={row.artist} id={selected ? selectedRowId : undefined} selected={selected} onSelect={onSelect} />
              ) : (
                <button
                  type="button"
                  aria-expanded={featuredOpen}
                  // Out of the way of the keyboard, which stays on the list.
                  tabIndex={-1}
                  className="flex h-full w-full cursor-pointer items-end gap-1.5 px-2 pb-2 text-xs font-medium text-muted-foreground transition-colors select-none hover:text-foreground"
                  onClick={toggleFeatured}
                >
                  <CaretRightIcon weight="bold" className={cn("mb-px size-3 transition-transform duration-100", featuredOpen && "rotate-90")} />
                  Features only
                  <span className="tabular-nums">{row.count}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
