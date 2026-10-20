import { createFileRoute } from "@tanstack/react-router";
import { CaretUpIcon, MusicNotesIcon, WarningIcon } from "@phosphor-icons/react";

import { QueueActions, usePlayingKey } from "#/queue/queue";
import { LibrarySort } from "@muswag/model";
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

const isSort = Schema.is(LibrarySort);

export const Route = createFileRoute("/app/songs/")({
  // The order the list is in, which is also the order the library plays in from here.
  validateSearch: (search: Record<string, unknown>): { sort?: LibrarySort } => (isSort(search.sort) && search.sort !== "title" ? { sort: search.sort } : {}),
  component: RouteComponent,
});

/** The orders a column of the list can put it in, by the column's id. The title column sorts by title or by the artist under it. */
const COLUMN_SORTS: Record<string, ReadonlyArray<{ sort: LibrarySort; label: string }>> = {
  title: [
    { sort: "title", label: "Title" },
    { sort: "artist", label: "Artist" },
  ],
  album: [{ sort: "album", label: "Album" }],
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

  const headerCell = ({ id, label }: TrackColumn) => {
    const sorts = COLUMN_SORTS[id];
    if (!sorts) return label;
    return (
      <span className="flex gap-2">
        {sorts.map((option) => (
          <button
            key={option.sort}
            type="button"
            aria-pressed={option.sort === sort}
            className={cn("flex items-center gap-0.5 hover:text-foreground", option.sort === sort && "text-foreground")}
            onClick={() => void navigate({ search: option.sort === "title" ? {} : { sort: option.sort }, replace: true })}
          >
            {option.label}
            {option.sort === sort ? <CaretUpIcon weight="bold" className="size-3" /> : null}
          </button>
        ))}
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
      topPadding={TOP_HEIGHT}
      bottomPadding={PLAYER_HEIGHT}
    />
  );
}
