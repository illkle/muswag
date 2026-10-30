import { createFileRoute } from "@tanstack/react-router";
import { CaretDownIcon, CaretUpIcon, MusicNotesIcon, WarningIcon } from "@phosphor-icons/react";

import { QueueActions, usePlayingKey } from "#/queue/queue";
import { LibrarySort, librarySortParts, type LibrarySortBy } from "@muswag/model";
import { Schema } from "effect";
import { libraryColumns, type TrackColumn } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import { LibraryActions } from "#/library/actions";
import { useSongRows } from "#/library/song-rows";
import { failureNotice } from "#/lib/notify";
import { cn } from "#/lib/utils";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";
import { PageState } from "#/components/page-state";
import { ShuffleButton } from "#/components/shuffle-button";

const isSort = Schema.is(LibrarySort);

/** The row of the button that shuffles the library, over the list's header. */
const SHUFFLE_ROW_HEIGHT = 40;

export const Route = createFileRoute("/app/songs/")({
  // The order the list is in, which is also the order the library plays in from here.
  validateSearch: (search: Record<string, unknown>): { sort?: LibrarySort } => (isSort(search.sort) && search.sort !== "title" ? { sort: search.sort } : {}),
  component: RouteComponent,
});

/** What a column of the list can sort it by, by the column's id. The title column sorts by title or by the artist under it. */
const COLUMN_SORTS: Record<string, ReadonlyArray<{ by: LibrarySortBy; label: string }>> = {
  title: [
    { by: "title", label: "Title" },
    { by: "artist", label: "Artist" },
  ],
  album: [{ by: "album", label: "Album" }],
};

function RouteComponent() {
  const sort = Route.useSearch().sort ?? "title";
  const navigate = Route.useNavigate();
  const { rows, isError } = useSongRows(sort);

  // The key is the same in every order of the library, so the row is marked whichever one is playing.
  const playingKey = usePlayingKey((ref) => ref.type === "library");

  if (!rows && isError) return <PageState tone="error" icon={<WarningIcon />} title="Songs unavailable" description="The songs could not be read from the local library. Trying again…" />;
  if (!rows) return <PageState tone="quiet" title="Loading songs…" />;
  if (rows.count === 0) {
    return <PageState icon={<MusicNotesIcon />} title="No songs yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  const { by, descending } = librarySortParts(sort);
  /** Sorts by what the button of `next` sorts by: the first time going up, and each time again the other way. */
  const sortBy = (next: LibrarySortBy) => {
    const nextSort: LibrarySort = next === by && !descending ? `${next}-desc` : next;
    void navigate({ search: nextSort === "title" ? {} : { sort: nextSort }, replace: true });
  };

  const headerCell = ({ id, label }: TrackColumn) => {
    const sorts = COLUMN_SORTS[id];
    if (!sorts) return label;
    const sorted = sorts.some((option) => option.by === by);
    const Caret = descending ? CaretDownIcon : CaretUpIcon;
    return (
      <span className="flex items-center gap-2">
        {sorts.map((option) => (
          <button
            key={option.by}
            type="button"
            aria-pressed={option.by === by}
            aria-label={option.by === by ? `${option.label}, ${descending ? "descending" : "ascending"}` : undefined}
            className={cn("hover:text-foreground", option.by === by && "text-foreground")}
            onClick={() => sortBy(option.by)}
          >
            {option.label}
          </button>
        ))}
        {/* One arrow after the column's buttons, which is there for either of them, so that neither moves the other. */}
        <Caret weight="bold" className={cn("-ml-1.5 size-3 text-foreground", !sorted && "invisible")} />
      </span>
    );
  };

  return (
    <TrackList
      // Another order is another list: what was selected and where the keyboard was do not carry over.
      key={sort}
      rows={rows}
      columns={libraryColumns}
      headerCell={headerCell}
      findPosition={(text) => LibraryActions.songPosition(sort, text)}
      playingKey={playingKey}
      showHeader
      onActivate={(item) => void QueueActions.playSource({ type: "library", sort }, item.key).catch(failureNotice("The song could not be played."))}
      menu={(selection) => <TrackMenuAddItems selection={selection} />}
      scrollId={`library-screen-songs-${sort}`}
      rememberScroll
      topContent={
        <div style={{ top: TOP_HEIGHT }} className="absolute px-4">
          <ShuffleButton source={{ type: "library", sort }} small />
        </div>
      }
      topPadding={TOP_HEIGHT + SHUFFLE_ROW_HEIGHT}
      bottomPadding={PLAYER_HEIGHT}
    />
  );
}
