import { PauseIcon, PlayIcon, SpinnerGapIcon, WarningIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { CoverSize } from "#shared/cover";
import { AlbumCover, type CoverPlaceholder } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { useAlbumCoverArt } from "#/library/album-cover-art";
import { formatDuration } from "#/lib/format";
import { cn } from "#/lib/utils";
import { usePlayerStatus } from "#/player/hooks";
import { useSongIsUnplayable } from "#/queue/unplayable";

import type { TrackItem } from "#/components/track-list/types";

export type TrackCellProps = {
  item: TrackItem;
  /** Where the track is in the list, counting tracks only, from zero. */
  position: number;
  isPlaying: boolean;
  /** Plays the track from this list. Absent where a row cannot be played. */
  onPlay?: (() => void) | undefined;
  /** For the links and buttons of the cell: 0 in the row the keyboard is on, the one row whose controls Tab stops at. */
  tabIndex: 0 | -1;
};

/** A shape in a cell of a row that has not loaded: across in percent of the column, down in pixels of the row. */
export type GhostShape = { x?: number; y: number; width: number; height: number; radius?: number };

/** One column of a track list. A list's columns decide both its grid and what each row shows. */
export type TrackColumn = {
  id: string;
  /** The column's CSS grid track size. */
  width: string;
  /** What the column is called in the header of a list that shows one. */
  label?: string;
  className?: string;
  Cell: (props: TrackCellProps) => ReactNode;
  /** What the cell shows in a row that has not loaded, for each of a few rows in turn, so that rows next to each other differ. */
  ghost?: readonly (readonly GhostShape[])[];
};

// ---- Cells ----

/** Replaces a row's number while it is the one playing. Only that row follows the player's status. */
function PlayingIndicator() {
  const status = usePlayerStatus();

  if (status === "loading") {
    return <SpinnerGapIcon className="size-4 animate-spin text-primary" />;
  }

  // Paused, ended, stopped or failed: the track is the current one, and nothing is heard.
  if (status !== "playing") {
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

/** A row's number, which gives way to a play button while the pointer is over the row or the keyboard is on it. */
function NumberCell({ number, isPlaying, onPlay, tabIndex }: { number: ReactNode } & Pick<TrackCellProps, "isPlaying" | "onPlay" | "tabIndex">) {
  if (isPlaying) return <PlayingIndicator />;
  if (!onPlay) return number;

  return (
    <>
      <button
        type="button"
        aria-label="Play"
        tabIndex={tabIndex}
        // Shown for the row the keyboard is on while the list has the focus, and kept once Tab has moved the focus onto it.
        className="peer hidden size-4 items-center justify-center text-foreground group-hover/row:flex group-data-cursor/row:group-focus-visible/list:flex focus-visible:flex focus-visible:text-brand"
        // Playing the row is not a click on it, so it leaves the selection alone.
        onClick={(event) => {
          event.stopPropagation();
          onPlay();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <PlayIcon weight="fill" className="size-3.5" />
      </button>
      <span className="group-hover/row:hidden group-data-cursor/row:group-focus-visible/list:hidden peer-focus-visible:hidden">{number}</span>
    </>
  );
}

/** Stands in for the number of a track that could not be played when the queue last started it. */
const UnplayableMark = () => <WarningIcon weight="fill" role="img" aria-label="Could not be played" className="size-3.5 text-destructive" />;

/** The song's number on its album. */
const TrackNumberCell = ({ item, isPlaying, onPlay, tabIndex }: TrackCellProps) => {
  const unplayable = useSongIsUnplayable(item.song.id);
  return <NumberCell number={unplayable ? <UnplayableMark /> : (item.song.track ?? "•")} isPlaying={isPlaying} onPlay={onPlay} tabIndex={tabIndex} />;
};

/** The row's number in this list. */
const PositionCell = ({ item, position, isPlaying, onPlay, tabIndex }: TrackCellProps) => {
  const unplayable = useSongIsUnplayable(item.song.id);
  return <NumberCell number={unplayable ? <UnplayableMark /> : position + 1} isPlaying={isPlaying} onPlay={onPlay} tabIndex={tabIndex} />;
};

/** The cover of a song's album, the size of a list row's unless `size` says otherwise. */
export const TrackCover = ({ albumId, className, size = "icon", placeholder }: { albumId: string; className?: string; size?: CoverSize; placeholder?: CoverPlaceholder }) => {
  const coverArtId = useAlbumCoverArt(albumId);
  return <AlbumCover size={size} className={className} target={{ type: "album", id: albumId, coverArtId }} placeholder={placeholder} />;
};

const CoverCell = ({ item }: TrackCellProps) => (
  <div className="size-10">
    {!item.unavailable && item.song.albumId ? <TrackCover albumId={item.song.albumId} placeholder={{ title: item.song.album ?? item.song.title }} /> : <div className="size-10 rounded bg-muted" />}
  </div>
);

const TitleCell = ({ item, isPlaying }: TrackCellProps) => <p className={cn("truncate text-sm", isPlaying && "text-brand")}>{item.song.title}</p>;

/** A link in a row. The cells clip what they hold, the outline of a focused link with it, so the focus underlines it as well. */
const LINK = "hover:underline focus-visible:underline";

const ArtistCell = ({ item: { song }, tabIndex }: TrackCellProps) => (
  <ArtistLinks
    artist={song.artist}
    artistId={song.artistId}
    artists={song.artists}
    className="line-clamp-1 text-sm text-muted-foreground"
    linkClassName={cn(LINK, "hover:text-foreground focus-visible:text-foreground")}
    tabIndex={tabIndex}
  />
);

/** The title over the artists, for lists that also show a cover. */
const TitleArtistCell = ({ item, isPlaying, tabIndex }: TrackCellProps) => {
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
      <ArtistLinks
        artist={song.artist}
        artistId={song.artistId}
        artists={song.artists}
        className="truncate text-xs text-muted-foreground"
        linkClassName={cn(LINK, "hover:text-foreground focus-visible:text-foreground")}
        tabIndex={tabIndex}
      />
    </div>
  );
};

const AlbumCell = ({ item, tabIndex }: TrackCellProps) => {
  const { song } = item;
  if (item.unavailable) return null;
  if (!song.albumId) return song.album;

  return (
    // Following the link is not a click on the row.
    <Link
      to="/app/albums/$albumId"
      params={{ albumId: song.albumId }}
      tabIndex={tabIndex}
      className={LINK}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
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

// Where the text of a cell is in a row that has not loaded: a line of small text, the title over the
// artists, and a line of text.
const SMALL_LINE = { y: 20, height: 8 };
const TITLE_LINE = { y: 11, height: 10 };
const ARTISTS_LINE = { y: 30, height: 8 };
const LINE = { y: 19, height: 10 };

/** Tracks from across the library, as the songs list and playlists show them. */
export const libraryColumns: readonly TrackColumn[] = [
  { id: "position", width: "32px", label: "#", className: NUMBER, Cell: PositionCell, ghost: [[{ ...SMALL_LINE, width: 80 }]] },
  { id: "cover", width: "40px", Cell: CoverCell, ghost: [[{ y: 4, width: 100, height: 40, radius: 4 }]] },
  {
    id: "title",
    width: "minmax(0,1fr)",
    label: "Title",
    Cell: TitleArtistCell,
    ghost: [
      [44, 24],
      [30, 16],
      [56, 30],
      [38, 20],
      [26, 14],
    ].map(([title, artists]) => [
      { ...TITLE_LINE, width: title! },
      { ...ARTISTS_LINE, width: artists! },
    ]),
  },
  {
    id: "album",
    width: "minmax(0,1fr)",
    label: "Album",
    className: "truncate text-sm text-muted-foreground",
    Cell: AlbumCell,
    ghost: [34, 48, 26, 40].map((width) => [{ ...LINE, width }]),
  },
  { id: "duration", width: "48px", label: "Time", className: DURATION, Cell: DurationCell, ghost: [[{ ...SMALL_LINE, x: 50, width: 50 }]] },
];

/**
 * Tracks listed as a playlist lists them, in a list that lists others another way: such as the songs an
 * artist appears on, under its albums. They are numbered from `first`, where the first of them is among
 * the list's tracks.
 */
export const libraryColumnsFrom = (first: number): readonly TrackColumn[] =>
  libraryColumns.map((column) => (column.id === "position" ? { ...column, Cell: (props: TrackCellProps) => <PositionCell {...props} position={props.position - first} /> } : column));

/** Tracks in a narrow panel. */
export const compactColumns: readonly TrackColumn[] = [
  { id: "cover", width: "40px", Cell: CoverCell },
  { id: "title", width: "minmax(0,1fr)", Cell: TitleArtistCell },
  { id: "duration", width: "auto", className: DURATION, Cell: DurationCell },
];
