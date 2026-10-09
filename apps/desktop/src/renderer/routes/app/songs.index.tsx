import { createFileRoute } from "@tanstack/react-router";
import { MusicNotesIcon, WarningIcon } from "@phosphor-icons/react";

import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { libraryOccurrenceKey, type LibrarySort } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";
import { libraryColumns } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem } from "#/components/track-list/types";
import { LIBRARY_SONGS } from "#/library/queries";
import { failureNotice } from "#/lib/notify";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";
import { PageState } from "#/components/page-state";
import { useMemo } from "react";

export const Route = createFileRoute("/app/songs/")({
  component: RouteComponent,
});

/** The order the list is in, which is also the order the library plays in from here. */
const SORT: LibrarySort = "title";

function RouteComponent() {
  const songsQuery = useLiveQuery(LIBRARY_SONGS[SORT]);
  const items = useMemo((): TrackListItem[] => songsQuery.data.map((song) => ({ type: "track", key: libraryOccurrenceKey(song.id), song })), [songsQuery.data]);

  const queueState = useQueueManagerState();
  // The key is the same in every order of the library, so the row is marked whichever one is playing.
  const playingKey = queueState.source?.ref.type === "library" && queueState.nowPlaying?.origin === "source" ? queueState.nowPlaying.key : null;

  if (songsQuery.isLoading) return <PageState tone="quiet" title="Loading songs…" />;
  if (songsQuery.isError) return <PageState tone="error" icon={<WarningIcon />} title="Songs unavailable" description="The local song list could not be read." />;
  if (items.length === 0) {
    return <PageState icon={<MusicNotesIcon />} title="No songs yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  return (
    <TrackList
      items={items}
      columns={libraryColumns}
      playingKey={playingKey}
      showHeader
      onActivate={(item) => void QueueActions.playSource({ type: "library", sort: SORT }, item.key).catch(failureNotice("The song could not be played."))}
      menu={(selection) => <TrackMenuAddItems selection={selection} />}
      scrollId="library-screen-songs"
      rememberScroll
      topPadding={TOP_HEIGHT}
      bottomPadding={PLAYER_HEIGHT}
    />
  );
}
