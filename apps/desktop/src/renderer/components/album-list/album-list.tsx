import { startTransition, useEffect, useMemo, useRef, useState, type JSX } from "react";

import { useContentSize } from "#/components/utils/app-content-size";
import { AlbumCover } from "#/components/album-list/album-cover";
import { getArtistCredits } from "#/components/utils/artist-links";
import { cn } from "#/lib/utils";
import type { Album } from "@muswag/shared";
import { useElementScrollRestoration, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { chunk } from "lodash-es";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";

export type AlbumListSection = {
  id: string;
  title: string;
  albums: Album[];
};

type AlbumListRow =
  | {
      id: string;
      type: "section";
      title: string;
    }
  | {
      albums: Album[];
      id: string;
      type: "albums";
    };

const SECTION_HEIGHT = 32;

const AlbumItem = ({
  album,
  instantCovers,
  ...props
}: {
  album: Album;
  instantCovers: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  const navigate = useNavigate();

  return (
    <button
      key={album.id}
      className="box-border flex w-full cursor-pointer flex-col justify-start rounded p-0.5 text-left align-bottom transition hover:bg-accent/10"
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
        target={{
          type: "album",
          id: album.id,
          coverArtId: album.coverArt ?? null,
        }}
      />

      <div className="mt-1">
        <h2 className="line-clamp-1 text-xs">{album.name}</h2>
        <p className="line-clamp-1 truncate text-xs text-muted-foreground">
          {getArtistCredits(album)
            .map((artist) => artist.name)
            .join(", ")}
        </p>
        <span className="line-clamp-1 text-xs text-muted-foreground/50">{album.year}</span>
      </div>
    </button>
  );
};

const calcSize = (totalSpace: number) => {
  const chunks = Math.max(1, Math.floor(totalSpace / 170));

  const BETWEEN_TEXT_AND_IMAGE = 8;
  const PAD_TOP_PLUS_BOTTOM = 2 * 2;

  const fullWidth = totalSpace / chunks;
  const paddings = BETWEEN_TEXT_AND_IMAGE + PAD_TOP_PLUS_BOTTOM;
  const coverSize = fullWidth - paddings;
  const textSize = 16 * 3;
  const fullHeight = textSize + coverSize + paddings;

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
        id: `albums-${section.id}-${index}`,
        type: "albums" as const,
      })),
    ];
  });
}

type AlbumListProps = {
  scrollId: string;
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

export function AlbumList({ albums, sections, scrollId, className, topPadding = TOP_HEIGHT, bottomPadding = PLAYER_HEIGHT, topContent }: AlbumListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);

  const scrollRestorationId = "album-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });

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
    ...(scrollEntry?.scrollY === undefined ? {} : { initialOffset: scrollEntry.scrollY }),
    paddingStart: topPadding,
    paddingEnd: bottomPadding,
    directDomUpdates: true,
  });

  return (
    <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className={cn("scrollbar overflow-y-auto px-2", className)}>
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
                className="absolute top-0 left-0 flex w-full items-end px-1 pb-2"
              >
                <h2 className="text-xl font-semibold tracking-tight">{row.title}</h2>
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
              <AlbumItemRow albums={row.albums} instantCovers={instantCovers} sizesStyle={sizesStyle} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const AlbumItemRow = ({ albums, instantCovers, sizesStyle }: { albums: Album[]; instantCovers: boolean; sizesStyle: Record<string, string> }) => {
  return (
    <>
      {albums.map((album) => (
        <AlbumItem key={album.id} instantCovers={instantCovers} album={album} style={sizesStyle} />
      ))}
    </>
  );
};
