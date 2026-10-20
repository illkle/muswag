import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties, type JSX } from "react";

import { useContentSize } from "#/components/utils/app-content-size";
import { AlbumCover } from "#/components/album-list/album-cover";
import { getArtistCredits } from "#/components/utils/artist-links";
import { scrollMemory } from "#/lib/scroll-memory";
import { cn } from "#/lib/utils";
import type { LibraryAlbum as Album } from "@muswag/model";
import type { AlbumRows } from "#/library/album-rows";
import { useElementScrollRestoration, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { chunk } from "lodash-es";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

export type AlbumListSection = {
  id: string;
  title: string;
  albums: Album[];
  /** Leaves the artist off the tiles, for a section that is all one artist's albums. */
  hideArtist?: boolean;
};

type AlbumListRow =
  | {
      id: string;
      type: "section";
      title: string;
    }
  | {
      albums: Album[];
      hideArtist: boolean;
      id: string;
      type: "albums";
    };

const SECTION_HEIGHT = 48;

/** Narrowest a tile gets before the grid drops a column. */
const MIN_TILE_WIDTH = 180;
/** Around a tile's content. Two tiles side by side put twice this between their covers. */
const TILE_PADDING = 8;
const COVER_TO_TEXT = 8;
/** The album's name over a line of details. */
const TEXT_HEIGHT = 20 + 16;

/** A tile of the grid. The columns of its row size it and its cover keeps itself square, so a change of width reaches it through CSS alone. */
const AlbumItem = memo(function AlbumItem({ album, hideArtist }: { album: Album; hideArtist: boolean }) {
  const navigate = useNavigate();
  const artist = hideArtist
    ? null
    : getArtistCredits(album)
        .map((credit) => credit.name)
        .join(", ");

  return (
    <button
      // The scroll margins keep a tile that Tab has reached clear of the top bar and the player, which lie over the ends of the grid.
      className="box-border flex w-full cursor-pointer scroll-mt-(--top-height) scroll-mb-(--player-height) flex-col justify-start rounded-lg p-2 text-left align-bottom transition-colors duration-100 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      onClick={() => {
        void navigate({
          to: "/app/albums/$albumId",
          params: { albumId: album.id },
        });
      }}
    >
      <AlbumCover
        size="thumbnail"
        target={{
          type: "album",
          id: album.id,
          coverArtId: album.coverArt ?? null,
        }}
      />

      <div className="mt-2 w-full">
        <h2 className="truncate text-sm font-medium">{album.name}</h2>
        <p className="flex gap-1 text-xs text-muted-foreground">
          {artist ? <span className="truncate">{artist}</span> : null}
          {artist && album.year ? <span>•</span> : null}
          {album.year ? <span className="shrink-0 tabular-nums">{album.year}</span> : null}
        </p>
      </div>
    </button>
  );
});

/** Stands in for a tile of a grid of `AlbumRows` whose album has not loaded yet. */
const LoadingItem = () => (
  <div className="p-2">
    <div className="aspect-square rounded border border-border bg-muted" />
    <div className="mt-3 h-3 w-2/3 rounded bg-muted" />
  </div>
);

const calcSize = (totalSpace: number) => {
  const chunks = Math.max(1, Math.floor(totalSpace / MIN_TILE_WIDTH));

  const fullWidth = totalSpace / chunks;
  const coverSize = fullWidth - 2 * TILE_PADDING;
  const fullHeight = coverSize + COVER_TO_TEXT + TEXT_HEIGHT + 2 * TILE_PADDING;

  return { fullWidth, fullHeight, chunks };
};

export function createAlbumListRows(sections: AlbumListSection[], columns: number): AlbumListRow[] {
  return sections.flatMap((section) => {
    if (section.albums.length === 0) {
      return [];
    }

    return [
      {
        id: `section-${section.id}`,
        type: "section" as const,
        title: section.title,
      },
      ...chunk(section.albums, columns).map((albums, index) => ({
        albums,
        hideArtist: section.hideArtist ?? false,
        id: `albums-${section.id}-${index}`,
        type: "albums" as const,
      })),
    ];
  });
}

type AlbumListProps = {
  scrollId: string;
  /** Comes back to where it was on any visit to the page, not only when going back to it. */
  rememberScroll?: boolean;
  className?: string;
  topPadding?: number;
  bottomPadding?: number;
  /** Rendered above the grid, absolutely positioned inside the scrolled area — reserve room with `topPadding`. */
  topContent?: JSX.Element;
} & (
  | {
      albums: Album[];
      sections?: never;
      rows?: never;
    }
  | {
      albums?: never;
      sections: AlbumListSection[];
      rows?: never;
    }
  /** The albums of a grid too long to hold, which loads them as it shows them. */
  | {
      albums?: never;
      sections?: never;
      rows: AlbumRows;
    }
);

export function AlbumList({ albums, sections, rows: albumRows, scrollId, rememberScroll = false, className, topPadding = TOP_HEIGHT, bottomPadding = PLAYER_HEIGHT, topContent }: AlbumListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const scrollRestorationId = "album-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });
  const initialOffset = scrollEntry?.scrollY ?? (rememberScroll ? scrollMemory.get(scrollRestorationId) : undefined);

  const contentSize = useContentSize();
  const sizes = useMemo(() => calcSize((contentSize.width || 600) - 32), [contentSize.width]);
  const rows = useMemo(
    () =>
      albumRows
        ? []
        : sections
          ? createAlbumListRows(sections, sizes.chunks)
          : chunk(albums, sizes.chunks).map((rowAlbums, index) => ({
              albums: rowAlbums,
              hideArtist: false,
              id: `albums-${index}`,
              type: "albums" as const,
            })),
    [albums, sections, albumRows, sizes.chunks],
  );
  const rowCount = albumRows ? Math.ceil(albumRows.count / sizes.chunks) : rows.length;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.type === "section" ? SECTION_HEIGHT : sizes.fullHeight),
    // A row of `AlbumRows` is its position, whether or not its albums have loaded.
    getItemKey: (index) => (albumRows ? index : (rows[index]?.id ?? index)),
    overscan: 4,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: topPadding,
    paddingEnd: bottomPadding,
    // A scroll is drawn in the next frame rather than at once, which keeps scrolling smooth.
    useFlushSync: false,
  });

  // The rows grow and shrink with the width of the page, which the virtualizer has to be told of. The tiles in them are left alone.
  useLayoutEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, sizes.fullHeight]);

  // The albums of the rows that are drawn, so that those not loaded yet load.
  const virtualRows = rowVirtualizer.getVirtualItems();
  const firstDrawn = (virtualRows[0]?.index ?? 0) * sizes.chunks;
  const lastDrawn = ((virtualRows.at(-1)?.index ?? -1) + 1) * sizes.chunks;
  useLayoutEffect(() => {
    if (albumRows && lastDrawn > firstDrawn) albumRows.show(firstDrawn, Math.min(lastDrawn, albumRows.count));
  }, [albumRows, firstDrawn, lastDrawn]);

  return (
    <div
      ref={parentRef}
      data-scroll-restoration-id={scrollRestorationId}
      className={cn("scrollbar overflow-y-auto px-2", className)}
      onScroll={rememberScroll ? (event) => scrollMemory.set(scrollRestorationId, event.currentTarget.scrollTop) : undefined}
    >
      <div
        style={
          {
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
            // The columns of every row. A change of width changes only this, until it takes a column more or less.
            "--album-columns": `repeat(${sizes.chunks}, ${sizes.fullWidth}px)`,
          } as CSSProperties
        }
      >
        {topContent}

        {virtualRows.map((virtualRow) => {
          if (albumRows) {
            const start = virtualRow.index * sizes.chunks;
            const end = Math.min(start + sizes.chunks, albumRows.count);
            return (
              <div
                key={virtualRow.key}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="absolute top-0 left-0 grid w-full grid-cols-(--album-columns)"
              >
                {Array.from({ length: end - start }, (_, offset) => {
                  const album = albumRows.at(start + offset);
                  // By position: while pages are read again after a change, an album can be at two positions for a moment.
                  return album ? <AlbumItem key={start + offset} album={album} hideArtist={false} /> : <LoadingItem key={start + offset} />;
                })}
              </div>
            );
          }

          const row = rows[virtualRow.index];

          if (!row) {
            return null;
          }

          if (row.type === "section") {
            return (
              <div
                key={row.id}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="absolute top-0 left-0 flex w-full items-end px-2 pb-1"
              >
                <h2 className="text-lg font-semibold tracking-tight">{row.title}</h2>
              </div>
            );
          }

          return (
            <div
              key={row.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="absolute top-0 left-0 grid w-full grid-cols-(--album-columns)"
            >
              <AlbumItemRow albums={row.albums} hideArtist={row.hideArtist} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The tiles of a row, which are drawn again only when the row holds other albums: scrolling or resizing moves the row, not them. */
const AlbumItemRow = memo(function AlbumItemRow({ albums, hideArtist }: { albums: Album[]; hideArtist: boolean }) {
  return (
    <>
      {albums.map((album) => (
        <AlbumItem key={album.id} hideArtist={hideArtist} album={album} />
      ))}
    </>
  );
});
