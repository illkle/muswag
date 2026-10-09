import { PauseIcon, PlayIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { db } from "#/data/library";
import { formatDuration } from "#/lib/format";
import { cn } from "#/lib/utils";
import { usePlayerStatus } from "#/player/hooks";

import type { TrackItem } from "#/components/track-list/types";

export type TrackCellProps = {
  item: TrackItem;
  /** Where the track is in the list, counting tracks only, from zero. */
  position: number;
  isPlaying: boolean;
  /** Plays the track from this list. Absent where a row cannot be played. */
  onPlay?: (() => void) | undefined;
};

/** One column of a track list. A list's columns decide both its grid and what each row shows. */
export type TrackColumn = {
  id: string;
  /** The column's CSS grid track size. */
  width: string;
  /** What the column is called in the header of a list that shows one. */
  label?: string;
  className?: string;
  Cell: (props: TrackCellProps) => ReactNode;
};

// ---- Cells ----

/** Replaces a row's number while it is the one playing. Only that row follows the player's status. */
function PlayingIndicator() {
  const status = usePlayerStatus();

  if (status === "loading") {
    return <SpinnerGapIcon className="size-4 animate-spin text-primary" />;
  }

  if (status === "paused") {
    return <PauseIcon weight="fill" className="size-4 text-primary" />;
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

/** A row's number, which gives way to a play button while the pointer is over the row. */
function NumberCell({ number, isPlaying, onPlay }: { number: ReactNode; isPlaying: boolean; onPlay: TrackCellProps["onPlay"] }) {
  if (isPlaying) return <PlayingIndicator />;
  if (!onPlay) return number;

  return (
    <>
      <span className="group-hover/row:hidden">{number}</span>
      <button
        type="button"
        aria-label="Play"
        className="hidden size-4 items-center justify-center text-foreground group-hover/row:flex"
        // Playing the row is not a click on it, so it leaves the selection alone.
        onClick={(event) => {
          event.stopPropagation();
          onPlay();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <PlayIcon weight="fill" className="size-3.5" />
      </button>
    </>
  );
}

/** The song's number on its album. */
const TrackNumberCell = ({ item, isPlaying, onPlay }: TrackCellProps) => <NumberCell number={item.song.track ?? "•"} isPlaying={isPlaying} onPlay={onPlay} />;

/** The row's number in this list. */
const PositionCell = ({ position, isPlaying, onPlay }: TrackCellProps) => <NumberCell number={position + 1} isPlaying={isPlaying} onPlay={onPlay} />;

export const TrackCover = ({ albumId, className }: { albumId: string; className?: string }) => {
  const cover = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((a) => eq(a.album.id, albumId))
      .findOne()
      .select((v) => ({
        cover: v.album.coverArtPath,
        coverArtId: v.album.coverArt,
        albumId: v.album.id,
      })),
  );

  return (
    <AlbumCover
      coverArtPath={cover.data?.cover}
      thumbnail
      className={className}
      target={cover.data ? { type: "album", id: cover.data.albumId, coverArtId: cover.data.coverArtId ?? null } : undefined}
    />
  );
};

const CoverCell = ({ item }: TrackCellProps) => (
  <div className="size-10">{!item.unavailable && item.song.albumId ? <TrackCover albumId={item.song.albumId} /> : <div className="size-10 rounded bg-muted" />}</div>
);

const TitleCell = ({ item, isPlaying }: TrackCellProps) => <p className={cn("truncate text-sm", isPlaying && "text-brand")}>{item.song.title}</p>;

const ArtistCell = ({ item: { song } }: TrackCellProps) => (
  <ArtistLinks artist={song.artist} artistId={song.artistId} artists={song.artists} className="line-clamp-1 text-sm text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
);

/** The title over the artists, for lists that also show a cover. */
const TitleArtistCell = ({ item, isPlaying }: TrackCellProps) => {
  const { song } = item;

  if (item.unavailable) {
    return (
      <div className="flex flex-col overflow-hidden">
        <div className="truncate text-sm italic">Not in local library</div>
        <div className="truncate font-mono text-xs text-muted-foreground">{song.id}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-hidden">
      <div className={cn("truncate text-sm", isPlaying && "text-brand")}>{song.title}</div>
      <ArtistLinks artist={song.artist} artistId={song.artistId} artists={song.artists} className="truncate text-xs text-muted-foreground" linkClassName="hover:text-foreground hover:underline" />
    </div>
  );
};

const AlbumCell = ({ item }: TrackCellProps) => {
  const { song } = item;
  if (item.unavailable) return null;
  if (!song.albumId) return song.album;

  return (
    // Following the link is not a click on the row.
    <Link to="/app/albums/$albumId" params={{ albumId: song.albumId }} className="hover:underline" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      {song.album}
    </Link>
  );
};

const DurationCell = ({ item }: TrackCellProps) => (item.unavailable ? "-" : formatDuration(item.song.duration));

// ---- Columns ----

const NUMBER = "truncate text-xs text-muted-foreground tabular-nums";
const DURATION = "text-right text-xs text-muted-foreground tabular-nums";

/** The tracks of one album: no cover or album name, since the page is already about them. */
export const albumColumns: readonly TrackColumn[] = [
  { id: "number", width: "32px", label: "#", className: NUMBER, Cell: TrackNumberCell },
  { id: "title", width: "minmax(0,1fr)", label: "Title", Cell: TitleCell },
  { id: "artist", width: "minmax(120px,0.45fr)", label: "Artist", Cell: ArtistCell },
  { id: "duration", width: "48px", label: "Time", className: DURATION, Cell: DurationCell },
];

/** The same for an album whose tracks are all credited as the album is, where the artist would only repeat. */
export const albumColumnsWithoutArtist: readonly TrackColumn[] = albumColumns.filter(({ id }) => id !== "artist");

/** Tracks from across the library, as the songs list and playlists show them. */
export const libraryColumns: readonly TrackColumn[] = [
  { id: "position", width: "32px", label: "#", className: NUMBER, Cell: PositionCell },
  { id: "cover", width: "40px", Cell: CoverCell },
  { id: "title", width: "minmax(0,1fr)", label: "Title", Cell: TitleArtistCell },
  { id: "album", width: "minmax(0,1fr)", label: "Album", className: "truncate text-sm text-muted-foreground", Cell: AlbumCell },
  { id: "duration", width: "48px", label: "Time", className: DURATION, Cell: DurationCell },
];

/** Tracks in a narrow panel. */
export const compactColumns: readonly TrackColumn[] = [
  { id: "cover", width: "40px", Cell: CoverCell },
  { id: "title", width: "minmax(0,1fr)", Cell: TitleArtistCell },
  { id: "duration", width: "auto", className: DURATION, Cell: DurationCell },
];
