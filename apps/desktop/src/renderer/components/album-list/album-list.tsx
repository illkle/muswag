import { startTransition, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { useContentSize } from "#/components/utils/app-content-size";
import { AlbumCover } from "#/components/album-list/album-cover";
import { getArtistCredits } from "#/components/utils/artist-links";
import { scrollMemory } from "#/lib/scroll-memory";
import { cn } from "#/lib/utils";
import type { Album } from "@muswag/model";
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

const AlbumItem = ({
  album,
  instantCovers,
  hideArtist,
  ...props
}: {
  album: Album;
  instantCovers: boolean;
  hideArtist: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  const navigate = useNavigate();
  const artist = hideArtist
    ? null
    : getArtistCredits(album)
        .map((credit) => credit.name)
        .join(", ");

  return (
    <button
      key={album.id}
      className="box-border flex w-full cursor-pointer flex-col justify-start rounded-lg p-2 text-left align-bottom transition-colors duration-100 outline-none hover:bg-muted/50 focus-visible:bg-muted/50"
      tabIndex={0}
      onClick={() => {
        void navigate({
          to: "/app/albums/$albumId",
          params: { albumId: album.id },
        });
      }}
      {...props}
    >
      <AlbumCover
        coverArtPath={album.coverArtPath}
        instantLoad={instantCovers}
        thumbnail
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
};

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
    }
  | {
      albums?: never;
      sections: AlbumListSection[];
    }
);

export function AlbumList({ albums, sections, scrollId, rememberScroll = false, className, topPadding = TOP_HEIGHT, bottomPadding = PLAYER_HEIGHT, topContent }: AlbumListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const scrollRestorationId = "album-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });
  const initialOffset = scrollEntry?.scrollY ?? (rememberScroll ? scrollMemory.get(scrollRestorationId) : undefined);

  const contentSize = useContentSize();
  const sizes = useMemo(() => calcSize((contentSize.width || 600) - 32), [contentSize.width]);
  const sizesStyle = useMemo(
    () => ({
      width: `${sizes.fullWidth}px`,
      height: `${sizes.fullHeight}px`,
    }),
    [sizes],
  );
  const rows = useMemo(
    () =>
      sections
        ? createAlbumListRows(sections, sizes.chunks)
        : chunk(albums, sizes.chunks).map((rowAlbums, index) => ({
            albums: rowAlbums,
            hideArtist: false,
            id: `albums-${index}`,
            type: "albums" as const,
          })),
    [albums, sections, sizes.chunks],
  );
  const [instantCovers, setInstantCovers] = useState(true);

  useEffect(() => {
    startTransition(() => {
      setInstantCovers(false);
    });
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.type === "section" ? SECTION_HEIGHT : sizes.fullHeight),
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 4,
    ...(initialOffset === undefined ? {} : { initialOffset }),
    paddingStart: topPadding,
    paddingEnd: bottomPadding,
    directDomUpdates: true,
  });

  return (
    <div
      ref={parentRef}
      data-scroll-restoration-id={scrollRestorationId}
      className={cn("scrollbar overflow-y-auto px-2", className)}
      onScroll={rememberScroll ? (event) => scrollMemory.set(scrollRestorationId, event.currentTarget.scrollTop) : undefined}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {topContent}

        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
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
              className="absolute top-0 left-0 flex w-full"
            >
              <AlbumItemRow albums={row.albums} hideArtist={row.hideArtist} instantCovers={instantCovers} sizesStyle={sizesStyle} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const AlbumItemRow = ({ albums, hideArtist, instantCovers, sizesStyle }: { albums: Album[]; hideArtist: boolean; instantCovers: boolean; sizesStyle: Record<string, string> }) => {
  return (
    <>
      {albums.map((album) => (
        <AlbumItem key={album.id} instantCovers={instantCovers} hideArtist={hideArtist} album={album} style={sizesStyle} />
      ))}
    </>
  );
};
