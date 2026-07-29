import { AlbumCover } from "#/components/album-cover";
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
}: {
  songs: Song[];
  discTitles?: Album["discTitles"];
  onSongPlay: (v: Song) => void;
  currentTrackID: string | null;
  playerStatus: PlayerStatus | null;
  SongComponent?: SongComponent;
  scrollId: string;
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
    <div ref={parentRef} data-scroll-restoration-id={scrollRestorationId} className="overflow-y-auto">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const song = songs[virtualRow.index]!;

          return (
            <div
              key={virtualRow.index}
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
                onDoubleClick={() => onSongPlay(song)}
                onClick={(e) => {
                  if (e.metaKey) {
                    setSelectionState((v) => ({ ...v, [song.id]: !v[song.id] }));
                    return;
                  }

                  setSelectionState(() => ({ [song.id]: true }));
                }}
                isSelected={selectionState[song.id]}
                isPlaying={song.id === currentTrackID}
                status={song.id === currentTrackID ? playerStatus : null}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

type SongVisualProps = {
  song: Song;
  isSelected?: boolean;
  isPlaying?: boolean;
  status?: PlayerStatus | null;
  index: number;
} & React.ComponentProps<"button">;

type SongComponent = (v: SongVisualProps) => JSX.Element;

export const SongRenderAlbum = ({ song, isPlaying, isSelected, status, ...props }: SongVisualProps) => {
  return (
    <button
      key={song.id}
      type="button"
      className={cn(
        "h-12 grid w-full gap-3 px-4 py-2 text-left transition-colors duration-100 md:grid-cols-[56px_minmax(0,1fr)_minmax(120px,0.45fr)_72px] md:items-center",
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
      <div className="text-sm text-muted-foreground line-clamp-1">{song.displayArtist ?? song.artist ?? "Unknown artist"}</div>
      <div className="text-sm font-medium text-muted-foreground md:text-right">{formatDuration(song.duration)}</div>
    </button>
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

export function SongRenderSongsList({ song, index }: SongVisualProps) {
  return (
    <div className="grid px-4 grid-cols-[40px_64px_1fr_1fr_48px] gap-4 w-full h-12 items-center">
      <div className="text-muted-foreground text-xs font-mono text-center">{index + 1}</div>
      <div className="w-10 h-10">{song.albumId ? <SongListCoverLoader albumID={song.albumId} /> : <></>}</div>
      <div className="flex flex-col overflow-hidden">
        <div className="truncate text-sm">{song.title}</div>
        <div className="truncate text-xs text-muted-foreground">{song.artist}</div>
      </div>
      <div className="text-sm text-muted-foreground">{song.album}</div>
      <div className="text-xs text-muted-foreground">{song.duration}</div>
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
