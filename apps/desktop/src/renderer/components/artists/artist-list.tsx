import type { Artist } from "@muswag/model";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useId, useRef, type KeyboardEvent } from "react";

import { AlbumCover } from "#/components/album-list/album-cover";
import { scrollMemory } from "#/lib/scroll-memory";
import { cn } from "#/lib/utils";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

const ROW_HEIGHT = 44;
const SCROLL_ID = "artist-list";

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
      <AlbumCover className="size-8 shrink-0 rounded-full" size="icon" target={{ type: "artist", id: artist.id, coverArtId: artist.coverArt ?? null }} />
      <span className="truncate">{artist.name}</span>
    </div>
  );
});

/**
 * The artists to pick from on the artists page. The list holds the focus, and the arrows, Page Up,
 * Page Down, Home and End pick the artist they move to.
 */
export function ArtistList({ artists, selectedId, onSelect, className }: { artists: readonly Artist[]; selectedId: string | null; onSelect: (artistId: string) => void; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedRowId = useId();
  const initialOffset = scrollMemory.get(SCROLL_ID);

  const virtualizer = useVirtualizer({
    count: artists.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => artists[index]?.id ?? index,
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

  const selectedIndex = artists.findIndex(({ id }) => id === selectedId);
  const virtualRows = virtualizer.getVirtualItems();
  const selectedDrawn = virtualRows.some(({ index }) => index === selectedIndex);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor((event.currentTarget.clientHeight - TOP_HEIGHT - PLAYER_HEIGHT) / ROW_HEIGHT) - 1);
    const last = artists.length - 1;
    const to = { ArrowDown: selectedIndex + 1, ArrowUp: selectedIndex - 1, PageDown: selectedIndex + page, PageUp: selectedIndex - page, Home: 0, End: last }[event.key];
    if (to === undefined || last < 0) return;
    event.preventDefault();
    const index = Math.min(Math.max(to, 0), last);
    onSelect(artists[index]!.id);
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
          const artist = artists[virtualRow.index]!;
          const selected = virtualRow.index === selectedIndex;

          return (
            <div key={artist.id} style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }} className="absolute top-0 left-0 w-full px-2">
              <ArtistRow artist={artist} id={selected ? selectedRowId : undefined} selected={selected} onSelect={onSelect} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
