import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type JSX, type MouseEvent as ReactMouseEvent } from "react";

import { useContentSize } from "#/components/utils/app-content-size";
import { XIcon } from "@phosphor-icons/react";

import { AlbumCover } from "#/components/album-list/album-cover";
import { EMPTY_SELECTION, selectForAction, selectOnClick } from "#/components/track-list/selection";
import { LibraryActions } from "#/library/actions";
import { startSongDrag } from "#/lib/song-drag";
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
/** Around a tile's content: a border, which keeps apart tiles selected side by side, and padding. Two tiles side by side put twice this between their covers. */
const TILE_PADDING = 8;
const COVER_TO_TEXT = 8;
/** The album's name over a line of details. */
const TEXT_HEIGHT = 20 + 16;

/** Selects the album `id` as a click with `modifiers` would. */
type SelectAlbum = (id: string, modifiers: { toggle: boolean; range: boolean }) => void;

/**
 * A tile of the grid. The columns of its row size it and its cover keeps itself square, so a change of width reaches it through CSS alone.
 * A click opens the album; with Cmd or Ctrl it adds the album to the selection or takes it out, and with Shift selects up to it.
 */
const AlbumItem = memo(function AlbumItem({ album, hideArtist, isSelected, onSelect }: { album: Album; hideArtist: boolean; isSelected: boolean; onSelect: SelectAlbum }) {
  const navigate = useNavigate();
  const artist = hideArtist
    ? null
    : getArtistCredits(album)
        .map((credit) => credit.name)
        .join(", ");

  return (
    <button
      draggable
      data-album-id={album.id}
      aria-pressed={isSelected}
      // The scroll margins keep a tile that Tab has reached clear of the top bar and the player, which lie over the ends of the grid.
      // Its corners are the cover's, 4px, with the padding and the border around them, so the two curve alike.
      className={cn(
        "box-border flex w-full cursor-pointer scroll-mt-(--top-height) scroll-mb-(--player-height) flex-col justify-start rounded-[12px] border-2 border-transparent bg-clip-padding p-1.5 text-left align-bottom transition-colors duration-100 outline-none select-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        isSelected && "bg-muted hover:bg-muted",
      )}
      onClick={(event) => {
        const toggle = event.metaKey || event.ctrlKey;
        if (toggle || event.shiftKey) return onSelect(album.id, { toggle, range: event.shiftKey });
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

  /** The albums the grid holds, in grid order. Of a grid of `AlbumRows`, only those it has read. */
  const heldAlbums = (): Album[] => {
    if (!albumRows) return rows.flatMap((row) => (row.type === "albums" ? row.albums : []));
    const held: Album[] = [];
    for (let position = 0; position < albumRows.count; position++) {
      const album = albumRows.at(position);
      if (album) held.push(album);
    }
    return held;
  };

  // Albums are selected by id, which holds while pages of the grid are read again.
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const selectRef = useRef<SelectAlbum>(() => {});
  useLayoutEffect(() => {
    selectRef.current = (id, modifiers) => {
      const order = heldAlbums().map(({ id }) => id);
      setSelection((state) => selectOnClick(state, order, id, modifiers));
    };
  });
  // The tiles are given one function to select with, so that selecting draws again only the tiles whose selection changed.
  const [selectAlbum] = useState((): SelectAlbum => (id, modifiers) => selectRef.current(id, modifiers));

  /** Dragging a tile drags the selection when the tile is part of it, and otherwise the tile's album alone, which it selects. */
  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const id = (event.target as Element).closest<HTMLElement>("[data-album-id]")?.dataset.albumId;
    if (id === undefined) return;
    const held = heldAlbums();
    // In grid order. A paged grid keeps selected albums whose pages it has let go of.
    const selected = held.flatMap((album) => (selection.keys.has(album.id) ? [album.id] : []));
    const dragged = selection.keys.has(id) ? [...new Set(albumRows ? [...selected, ...selection.keys] : selected)] : [id];
    setSelection((state) => selectForAction(state, id));
    const label = dragged.length === 1 ? (held.find((album) => album.id === id)?.name ?? "1 album") : `${dragged.length} albums`;
    startSongDrag(event, { label, songIds: () => LibraryActions.albumSongIds(dragged) });
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A click between the tiles lets go of the selection.
    if (!(event.target as Element).closest("[data-album-id]")) setSelection(EMPTY_SELECTION);
  };
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
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Escape") setSelection(EMPTY_SELECTION);
      }}
      onDragStart={onDragStart}
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
                  return album ? (
                    <AlbumItem key={start + offset} album={album} hideArtist={false} isSelected={selection.keys.has(album.id)} onSelect={selectAlbum} />
                  ) : (
                    <LoadingItem key={start + offset} />
                  );
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
              <AlbumItemRow albums={row.albums} hideArtist={row.hideArtist} selected={selection.keys} onSelect={selectAlbum} />
            </div>
          );
        })}
      </div>

      {selection.keys.size > 0 ? (
        // Kept at the bottom of the view, just above the player, however far the grid scrolls.
        <div className="pointer-events-none sticky bottom-0 z-30 h-0">
          <div
            className="pointer-events-auto absolute bottom-[calc(var(--player-height)+0.25rem)] left-1/2 flex h-8 -translate-x-1/2 overflow-hidden rounded-full surface-raised text-sm"
            // Not a click between the tiles.
            onClick={(event) => event.stopPropagation()}
          >
            <span className="flex items-center pr-3 pl-3.5 tabular-nums">
              {selection.keys.size} {selection.keys.size === 1 ? "album" : "albums"} selected
            </span>
            <button
              type="button"
              aria-label="Clear selection"
              className="flex items-center border-l border-foreground/10 pr-3 pl-2.5 text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
              onClick={() => setSelection(EMPTY_SELECTION)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The tiles of a row, which are drawn again only when the row holds other albums: scrolling or resizing moves the row, not them. */
const AlbumItemRow = memo(function AlbumItemRow({ albums, hideArtist, selected, onSelect }: { albums: Album[]; hideArtist: boolean; selected: ReadonlySet<string>; onSelect: SelectAlbum }) {
  return (
    <>
      {albums.map((album) => (
        <AlbumItem key={album.id} hideArtist={hideArtist} album={album} isSelected={selected.has(album.id)} onSelect={onSelect} />
      ))}
    </>
  );
});
