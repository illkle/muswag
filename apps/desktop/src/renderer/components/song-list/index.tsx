import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { db } from "#/lib/db-renderer";
import { cn } from "#/lib/utils";
import type { PlayerStatus } from "#shared/player.ts";
import type { Album, Song } from "@muswag/shared";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { Link, useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PauseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "#/components/ui/context-menu";
import { AddToPlaylistMenu } from "#/components/playlist/add-to-playlist-menu";
import { PlaylistFormDialog } from "#/components/playlist/playlist-form-dialog";
import { PlaylistActions } from "#/lib/playlist-actions";

function makeGridSvg(size: number) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
         width="${size}"
         height="${size}"
         viewBox="0 0 ${size} ${size}">
      <path
        d="M ${size} 0 H 0 V ${size}"
        fill="red"
      />
    </svg>
  `;

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const SongListRoot = ({
  songs,
  discTitles,
  onSongPlay,
  currentTrackID,
  playerStatus,
  SongComponent = SongRenderAlbum,
  scrollId,
  rowKeys,
  playingRowKey,
  unavailableRowKeys,
  topPadding,
  topContent,
  bottomPadding,
}: {
  songs: Song[];
  discTitles?: Album["discTitles"];
  onSongPlay: (song: Song, index: number) => void;
  currentTrackID: string | null;
  playerStatus: PlayerStatus | null;
  SongComponent?: SongComponent;
  scrollId: string;
  /**
   * Stable per-row identity, defaulting to the song id. Playlists pass entry ids so that the same
   * song appearing twice is two independently selectable rows.
   */
  rowKeys?: readonly string[];
  /** Takes precedence over matching on `currentTrackID` when the caller knows which row is playing. */
  playingRowKey?: string | null;
  unavailableRowKeys?: ReadonlySet<string>;
  /** Per-row controls, rendered in a trailing column that appears on hover. */
  rowActions?: (song: Song, index: number) => ReactNode;

  topPadding?: number;
  bottomPadding?: number;

  topContent?: JSX.Element;
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const scrollRestorationId = "song-list-" + scrollId;
  const scrollEntry = useElementScrollRestoration({
    id: scrollRestorationId,
  });

  const SIZE = 48;

  const shouldRenderTitle = (i: number) => {
    return renderDiscTitles && songs[i]?.discNumber && (i === 0 || songs[i - 1]?.discNumber != songs[i].discNumber);
  };

  const rowVirtualizer = useVirtualizer({
    count: songs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (shouldRenderTitle(i) ? SIZE * 2 : SIZE),
    overscan: 10,
    initialOffset: scrollEntry?.scrollY,
    paddingStart: topPadding,
    paddingEnd: bottomPadding,
  });

  const renderDiscTitles = discTitles && discTitles?.length > 1;

  const [selectionState, setSelectionState] = useState<Record<string, boolean>>({});
  const songIds = useMemo(() => Object.keys(selectionState), [selectionState]);

  const [playlistCreatorOpen, setPlaylistCreatorOpen] = useState(false);

  const toggleSelection = ({ rowKey, append, onlyAdd }: { rowKey: string; append?: boolean; onlyAdd?: boolean }) => {
    if (append) {
      setSelectionState((v) => ({ ...v, [rowKey]: onlyAdd ? true : !v[rowKey] }));
      return;
    }

    setSelectionState(() => ({ [rowKey]: true }));
  };

  const backgroundImage = useMemo(() => `url("${makeGridSvg(SIZE)}")`, []);

  return (
    <ContextMenu>
      <PlaylistFormDialog
        open={playlistCreatorOpen}
        onOpenChange={setPlaylistCreatorOpen}
        title="New playlist"
        submitLabel="Create"
        onSubmit={async ({ name, comment, public: isPublic }) => {
          const created = await PlaylistActions.createWithSongs(name, songIds);
          if (comment) await PlaylistActions.setComment(created.id, comment);
          if (isPublic) await PlaylistActions.setVisibility(created.id, true);
        }}
      />

      <ContextMenuContent>
        <ContextMenuGroup>
          <AddToPlaylistMenu setCreateOpen={setPlaylistCreatorOpen} songIds={songIds} />
          <ContextMenuItem>hello</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
      <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className="scrollbar h-full overflow-y-auto">
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
          }}
          className="overflow relative w-full"
        >
          <div
            className="absolute hidden h-full w-full"
            style={{
              height: `calc(100% - ${topPadding ?? 0}px - ${bottomPadding ?? 0}px)`,
              backgroundImage,
              backgroundRepeat: "repeat",
              backgroundSize: `${SIZE}px ${SIZE}px`,
              top: topPadding + "px",
            }}
          ></div>

          {topContent}

          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const song = songs[virtualRow.index]!;
            const rowKey = rowKeys?.[virtualRow.index] ?? song.id;
            const isPlaying = playingRowKey === undefined ? song.id === currentTrackID : playingRowKey === rowKey;

            return (
              <div
                key={rowKey}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className="absolute top-0 left-0 z-5 flex w-full"
              >
                {shouldRenderTitle(virtualRow.index) && renderDiscTitles && song.discNumber && (
                  <>
                    <div className="flex items-center justify-between bg-muted/35 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Disc {song.discNumber}</p>
                        {discTitles[song.discNumber]!.title ? <p className="truncate text-sm text-muted-foreground">{discTitles[song.discNumber]?.title}</p> : null}
                      </div>
                    </div>
                  </>
                )}
                <SongComponent
                  song={song}
                  index={virtualRow.index}
                  onDoubleClick={() => onSongPlay(song, virtualRow.index)}
                  onClick={(e) => {
                    if (e.button == 0) {
                      toggleSelection({ rowKey, append: e.metaKey });
                    }
                  }}
                  onPointerDown={(e) => {
                    if (e.button == 2) {
                      toggleSelection({ rowKey, append: true, onlyAdd: true });
                    }
                  }}
                  isSelected={selectionState[rowKey]}
                  isPlaying={isPlaying}
                  status={isPlaying ? playerStatus : null}
                  isUnavailable={unavailableRowKeys?.has(rowKey)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </ContextMenu>
  );
};

export type SongVisualProps = {
  song: Song;
  isSelected?: boolean;
  isPlaying?: boolean;
  status?: PlayerStatus | null;
  index: number;
  /** The playlist references this song but it is not in the synced local library. */
  isUnavailable?: boolean;
  actions?: ReactNode;
} & React.ComponentProps<"div">;

type SongComponent = (v: SongVisualProps) => JSX.Element;

const SongListCoverLoader = ({ albumID }: { albumID: string }) => {
  const cover = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((a) => eq(a.album.id, albumID))
      .findOne()
      .select((v) => ({
        cover: v.album.coverArtPath,
        coverArtId: v.album.coverArt,
        albumId: v.album.id,
      })),
  );

  return <AlbumCover coverArtPath={cover.data?.cover} target={cover.data ? { type: "album", id: cover.data.albumId, coverArtId: cover.data.coverArtId ?? null } : undefined} />;
};

// `isUnavailable` is destructured only to keep it off the spread onto the DOM node.
export const SongRenderAlbum = ({ song, isPlaying, isSelected, status, isUnavailable: _isUnavailable, actions, ...props }: SongVisualProps) => {
  return (
    <ContextMenuTrigger
      key={song.id}
      className={cn(
        "group grid h-12 w-full gap-3 px-4 py-2 text-left transition-colors duration-100 md:grid-cols-[56px_minmax(0,1fr)_minmax(120px,0.45fr)_72px_32px] md:items-center",
        "hover:bg-muted/30 focus-visible:bg-muted/60 focus-visible:outline-none",
        isSelected && "bg-muted/60 hover:bg-muted/70",
      )}
      {...props}
    >
      <div className="line-clamp-1 text-sm font-medium text-muted-foreground">{isPlaying && status ? renderTrackStateIcon(status) : (song.track ?? "•")}</div>
      <div className="min-w-0">
        <p className={cn("truncate font-light", isPlaying && "font-bold")}>{song.title}</p>
      </div>
      <ArtistLinks artist={song.artist} artistId={song.artistId} artists={song.artists} className="line-clamp-1 text-sm text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
      <div className="text-sm font-medium text-muted-foreground md:text-right">{formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </ContextMenuTrigger>
  );
};

export function SongRenderSongsList({ song, index, status, actions, isPlaying, isSelected, ...props }: SongVisualProps) {
  return (
    <ContextMenuTrigger
      key={song.id}
      className={cn(
        "group grid h-12 w-full grid-cols-[40px_64px_1fr_1fr_48px_32px] items-center gap-4 px-4",
        "hover:bg-muted/30 focus-visible:bg-muted/60 focus-visible:outline-none",
        isSelected && "bg-muted/60 hover:bg-muted/70",
      )}
      {...props}
    >
      <div className="line-clamp-1 font-mono text-sm text-muted-foreground">{isPlaying && status ? renderTrackStateIcon(status) : index + 1}</div>
      <div className="h-10 w-10">{song.albumId ? <SongListCoverLoader albumID={song.albumId} /> : <></>}</div>
      <div className="flex flex-col overflow-hidden">
        <div className="truncate text-sm">{song.title}</div>
        <ArtistLinks artist={song.artist} artistId={song.artistId} artists={song.artists} className="truncate text-xs text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
      </div>
      <div className="text-sm text-muted-foreground">
        <Link to="/app/albums/$albumId" params={{ albumId: song.albumId ?? "" }} className="hover:underline">
          {song.album}
        </Link>
      </div>
      <div className="text-xs text-muted-foreground">{formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </ContextMenuTrigger>
  );
}

export function SongRenderPlaylist({ song, index, isPlaying, isSelected, status, isUnavailable, actions, ...props }: SongVisualProps) {
  return (
    <ContextMenuTrigger
      className={cn(
        "group grid h-12 w-full grid-cols-[40px_64px_1fr_1fr_48px_32px] items-center gap-4 px-4 transition-colors duration-100",
        "hover:bg-muted/30",
        isSelected && "bg-muted/60 hover:bg-muted/70",
        isUnavailable && "opacity-50",
      )}
      {...props}
    >
      <div className="text-center font-mono text-xs text-muted-foreground">{isPlaying && status ? renderTrackStateIcon(status) : index + 1}</div>
      <div className="h-10 w-10">{!isUnavailable && song.albumId ? <SongListCoverLoader albumID={song.albumId} /> : <div className="size-10 rounded bg-muted" />}</div>

      {isUnavailable ? (
        <div className="flex flex-col overflow-hidden">
          <div className="truncate text-sm italic">Not in local library</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{song.id}</div>
        </div>
      ) : (
        <div className="flex flex-col overflow-hidden">
          <div className={cn("truncate text-sm", isPlaying && "font-bold")}>{song.title}</div>
          <ArtistLinks artist={song.artist} artistId={song.artistId} artists={song.artists} className="truncate text-xs text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
        </div>
      )}

      <div className="truncate text-sm text-muted-foreground">{isUnavailable ? "" : song.album}</div>
      <div className="text-xs text-muted-foreground">{isUnavailable ? "-" : formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </ContextMenuTrigger>
  );
}

function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) {
    return "-";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderTrackStateIcon(status: PlayerStatus): ReactNode {
  if (status === "loading") {
    return <SpinnerGapIcon className="size-4 animate-spin text-primary" />;
  }

  if (status === "paused") {
    return <PauseIcon className="size-4 text-primary" />;
  }

  return (
    <div className="playing-indicator flex h-4 w-4 gap-0.5">
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
    </div>
  );
}
