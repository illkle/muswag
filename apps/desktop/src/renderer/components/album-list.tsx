import { startTransition, useEffect, useMemo, useRef, useState } from "react";

import { useContentSize } from "#/components/app-content-size";
import { AlbumCover } from "#/components/album-cover";
import { getArtistCredits } from "#/components/artist-links";
import { cn } from "#/lib/utils";
import type { Album } from "@muswag/shared";
import { useElementScrollRestoration, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { chunk } from "lodash-es";

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

const SECTION_HEIGHT = 56;

const AlbumItem = ({
  album,
  instantCovers,
  ...props
}: {
  album: Album;
  instantCovers: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) => {
  return (
    <button
      key={album.id}
      className="flex w-full cursor-pointer flex-col justify-start rounded p-1 text-left align-bottom transition hover:bg-accent"
      tabIndex={0}
      {...props}
    >
      <AlbumCover
        coverArtPath={album.coverArtPath}
        instantLoad={instantCovers}
        target={{ type: "album", id: album.id, coverArtId: album.coverArt ?? null }}
      />

      <p className="mt-2 line-clamp-1 truncate text-xs">
        {getArtistCredits(album)
          .map((artist) => artist.name)
          .join(", ")}
      </p>
      <h2 className="line-clamp-2 text-xs font-semibold">{album.name}</h2>
      <p className="line-clamp-1 text-xs text-muted-foreground">{album.year}</p>
    </button>
  );
};

const calcSize = (totalSpace: number) => {
  const chunks = Math.max(1, Math.floor(totalSpace / 150));

  const fullWidth = totalSpace / chunks;
  const paddings = 8;
  const coverSize = fullWidth - paddings;
  const textSize = 64;
  const fullHeight = textSize + 16 + coverSize + paddings;

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

export function AlbumList({ albums, sections, scrollId, className }: AlbumListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const scrollRestorationId = "album-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });

  const contentSize = useContentSize();
  const sizes = useMemo(() => calcSize(contentSize.width || 600), [contentSize.width]);
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
    initialOffset: scrollEntry?.scrollY,
  });

  return (
    <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className={cn("overflow-y-auto", className)}>
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
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
              {row.albums.map((album) => (
                <AlbumItem
                  key={album.id}
                  instantCovers={instantCovers}
                  album={album}
                  style={{
                    width: `${sizes.fullWidth}px`,
                    height: `${sizes.fullHeight}px`,
                  }}
                  onClick={() => {
                    void navigate({
                      to: "/app/albums/$albumId",
                      params: { albumId: album.id },
                    });
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
