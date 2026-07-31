import { AlbumCover } from "#/components/album-cover";
import { ArtistLinks } from "#/components/artist-links";
import { db } from "#/lib/db-renderer";
import { cn } from "#/lib/utils";
import type { PlayerStatus } from "#shared/player.ts";
import type { Album, Song } from "@muswag/shared";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { useElementScrollRestoration } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { LoaderCircle, PauseIcon } from "lucide-react";
import { useRef, useState, type JSX, type ReactNode } from "react";

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
  rowActions,
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
  });

  const renderDiscTitles = discTitles && discTitles?.length > 1;

  const [selectionState, setSelectionState] = useState<Record<string, boolean>>({});

  return (
    <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className="overflow-y-auto h-full">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
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
              className="absolute top-0 left-0 w-full flex z-5"
            >
              {shouldRenderTitle(virtualRow.index) && renderDiscTitles && song.discNumber && (
                <>
                  <div className="flex items-center justify-between bg-muted/35 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Disc {song.discNumber}</p>
                      {discTitles[song.discNumber]!.title ? (
                        <p className="truncate text-sm text-muted-foreground">{discTitles[song.discNumber]?.title}</p>
                      ) : null}
                    </div>
                  </div>
                </>
              )}
              <SongComponent
                song={song}
                index={virtualRow.index}
                onDoubleClick={() => onSongPlay(song, virtualRow.index)}
                onClick={(e) => {
                  if (e.metaKey) {
                    setSelectionState((v) => ({ ...v, [rowKey]: !v[rowKey] }));
                    return;
                  }

                  setSelectionState(() => ({ [rowKey]: true }));
                }}
                isSelected={selectionState[rowKey]}
                isPlaying={isPlaying}
                status={isPlaying ? playerStatus : null}
                isUnavailable={unavailableRowKeys?.has(rowKey)}
                actions={rowActions?.(song, virtualRow.index)}
              />
            </div>
          );
        })}
      </div>
    </div>
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

// `isUnavailable` is destructured only to keep it off the spread onto the DOM node.
export const SongRenderAlbum = ({
  song,
  isPlaying,
  isSelected,
  status,
  isUnavailable: _isUnavailable,
  actions,
  ...props
}: SongVisualProps) => {
  return (
    <div
      key={song.id}
      className={cn(
        "group grid h-12 w-full gap-3 px-4 py-2 text-left transition-colors duration-100 md:grid-cols-[56px_minmax(0,1fr)_minmax(120px,0.45fr)_72px_32px] md:items-center",
        "hover:bg-muted/30 focus-visible:bg-muted/60 focus-visible:outline-none",
        isSelected && "bg-muted/60 hover:bg-muted/70",
      )}
      {...props}
    >
      <div className="text-sm font-medium text-muted-foreground line-clamp-1">
        {isPlaying && status ? renderTrackStateIcon(status) : (song.track ?? "•")}
      </div>
      <div className="min-w-0">
        <p className={cn("truncate font-light", isPlaying && "font-bold")}>{song.title}</p>
        {song.comment ? <p className="truncate text-sm text-muted-foreground line-clamp-1">{song.comment}</p> : null}
      </div>
      <ArtistLinks
        artist={song.artist}
        artistId={song.artistId}
        artists={song.artists}
        className="line-clamp-1 text-sm text-muted-foreground"
        linkClassName="hover:text-foreground hover:underline"
      />
      <div className="text-sm font-medium text-muted-foreground md:text-right">{formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </div>
  );
};

const SongListCoverLoader = ({ albumID }: { albumID: string }) => {
  const cover = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((a) => eq(a.album.id, albumID))
      .findOne()
      .select((v) => ({
        cover: v.album.coverArtPath,
      })),
  );

  return <AlbumCover coverArtPath={cover.data?.cover} />;
};

export function SongRenderSongsList({ song, index, actions }: SongVisualProps) {
  return (
    <div className="group grid px-4 grid-cols-[40px_64px_1fr_1fr_48px_32px] gap-4 w-full h-12 items-center">
      <div className="text-muted-foreground text-xs font-mono text-center">{index + 1}</div>
      <div className="w-10 h-10">{song.albumId ? <SongListCoverLoader albumID={song.albumId} /> : <></>}</div>
      <div className="flex flex-col overflow-hidden">
        <div className="truncate text-sm">{song.title}</div>
        <ArtistLinks
          artist={song.artist}
          artistId={song.artistId}
          artists={song.artists}
          className="truncate text-xs text-muted-foreground"
          linkClassName="hover:text-foreground hover:underline"
        />
      </div>
      <div className="text-sm text-muted-foreground">{song.album}</div>
      <div className="text-xs text-muted-foreground">{formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </div>
  );
}

export function SongRenderPlaylist({ song, index, isPlaying, isSelected, status, isUnavailable, actions, ...props }: SongVisualProps) {
  return (
    <div
      className={cn(
        "group grid px-4 grid-cols-[40px_64px_1fr_1fr_48px_32px] gap-4 w-full h-12 items-center transition-colors duration-100",
        "hover:bg-muted/30",
        isSelected && "bg-muted/60 hover:bg-muted/70",
        isUnavailable && "opacity-50",
      )}
      {...props}
    >
      <div className="text-muted-foreground text-xs font-mono text-center">
        {isPlaying && status ? renderTrackStateIcon(status) : index + 1}
      </div>
      <div className="w-10 h-10">
        {!isUnavailable && song.albumId ? <SongListCoverLoader albumID={song.albumId} /> : <div className="size-10 rounded bg-muted" />}
      </div>

      {isUnavailable ? (
        <div className="flex flex-col overflow-hidden">
          <div className="truncate text-sm italic">Not in local library</div>
          <div className="truncate text-xs text-muted-foreground font-mono">{song.id}</div>
        </div>
      ) : (
        <div className="flex flex-col overflow-hidden">
          <div className={cn("truncate text-sm", isPlaying && "font-bold")}>{song.title}</div>
          <ArtistLinks
            artist={song.artist}
            artistId={song.artistId}
            artists={song.artists}
            className="truncate text-xs text-muted-foreground"
            linkClassName="hover:text-foreground hover:underline"
          />
        </div>
      )}

      <div className="text-sm text-muted-foreground truncate">{isUnavailable ? "" : song.album}</div>
      <div className="text-xs text-muted-foreground">{isUnavailable ? "-" : formatDuration(song.duration)}</div>
      <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{actions}</div>
    </div>
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
    return <LoaderCircle className="size-4 animate-spin text-primary" />;
  }

  if (status === "paused") {
    return <PauseIcon className="size-4 text-primary" />;
  }

  return (
    <div className="w-4 h-4 flex gap-0.5 playing-indicator">
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
      <div className="bg-primary"></div>
    </div>
  );
}
