import { PauseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
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
};

/** One column of a track list. A list's columns decide both its grid and what each row shows. */
export type TrackColumn = {
  id: string;
  /** The column's CSS grid track size. */
  width: string;
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

/** The song's number on its album. */
const TrackNumberCell = ({ item, isPlaying }: TrackCellProps) => (isPlaying ? <PlayingIndicator /> : (item.song.track ?? "•"));

/** The row's number in this list. */
const PositionCell = ({ position, isPlaying }: TrackCellProps) => (isPlaying ? <PlayingIndicator /> : position + 1);

export const TrackCover = ({ albumId }: { albumId: string }) => {
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

  return <AlbumCover coverArtPath={cover.data?.cover} target={cover.data ? { type: "album", id: cover.data.albumId, coverArtId: cover.data.coverArtId ?? null } : undefined} />;
};

const CoverCell = ({ item }: TrackCellProps) => (
  <div className="size-10">{!item.unavailable && item.song.albumId ? <TrackCover albumId={item.song.albumId} /> : <div className="size-10 rounded bg-muted" />}</div>
);

const TitleCell = ({ item, isPlaying }: TrackCellProps) => <p className={cn("truncate font-light", isPlaying && "font-bold")}>{item.song.title}</p>;

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
      <div className={cn("truncate text-sm", isPlaying && "font-bold")}>{song.title}</div>
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

/** The tracks of one album: no cover or album name, since the page is already about them. */
export const albumColumns: readonly TrackColumn[] = [
  { id: "number", width: "56px", className: "truncate text-sm font-medium text-muted-foreground", Cell: TrackNumberCell },
  { id: "title", width: "minmax(0,1fr)", Cell: TitleCell },
  { id: "artist", width: "minmax(120px,0.45fr)", Cell: ArtistCell },
  { id: "duration", width: "72px", className: "text-right text-sm font-medium text-muted-foreground tabular-nums", Cell: DurationCell },
];

/** Tracks from across the library, as the songs list and playlists show them. */
export const libraryColumns: readonly TrackColumn[] = [
  { id: "position", width: "40px", className: "truncate font-mono text-xs text-muted-foreground", Cell: PositionCell },
  { id: "cover", width: "40px", Cell: CoverCell },
  { id: "title", width: "minmax(0,1fr)", Cell: TitleArtistCell },
  { id: "album", width: "minmax(0,1fr)", className: "truncate text-sm text-muted-foreground", Cell: AlbumCell },
  { id: "duration", width: "48px", className: "text-right text-xs text-muted-foreground tabular-nums", Cell: DurationCell },
];

/** Tracks in a narrow panel. */
export const compactColumns: readonly TrackColumn[] = [
  { id: "cover", width: "40px", Cell: CoverCell },
  { id: "title", width: "minmax(0,1fr)", Cell: TitleArtistCell },
  { id: "duration", width: "auto", className: "text-xs text-muted-foreground tabular-nums", Cell: DurationCell },
];
