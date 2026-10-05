import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { useUser } from "#/session/session";
import { db } from "#/data/library";
import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { LIBRARY_ORDERS, libraryOccurrenceKey, type LibrarySort } from "@muswag/model";
import { useLiveQuery } from "@tanstack/react-db";
import { libraryColumns } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem } from "#/components/track-list/types";
import { PLAYER_HEIGHT, TOP_HEIGHT } from "#/styles";
import { useMemo } from "react";

export const Route = createFileRoute("/app/songs/")({
  component: RouteComponent,
});

/** The order the list is in, which is also the order the library plays in from here. */
const SORT: LibrarySort = "title";

function LibraryScreen() {
  // Main reads the same columns in SQLite to play the library in this order. Its text comparison
  // is the lexical one, so the two put the songs in the same order.
  const songsQuery = useLiveQuery((q) => q.from({ song: db.songs }).orderBy(({ song }) => LIBRARY_ORDERS[SORT].map((column) => song[column]), { stringSort: "lexical" }));
  const items = useMemo((): TrackListItem[] => (songsQuery.data ?? []).map((song) => ({ type: "track", key: libraryOccurrenceKey(song.id), song })), [songsQuery.data]);

  const queueState = useQueueManagerState();
  // The key is the same in every order of the library, so the row is marked whichever one is playing.
  const playingKey = queueState.source?.ref.type === "library" && queueState.nowPlaying?.origin === "source" ? queueState.nowPlaying.key : null;

  return (
    <section className="flex h-full w-full flex-col">
      {songsQuery.isLoading ? <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading albums...</div> : null}

      {songsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>{"The local album list could not be read."}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) === 0 ? (
        <div className="mx-auto mt-(--top-height) flex max-w-md flex-col items-center justify-center gap-3 rounded-2xl py-10">
          <div className="space-y-1">
            <p className="font-medium">No songs in the local database yet.</p>
            <p className="text-sm text-muted-foreground">Use the server control in the sidebar to fetch your server library.</p>
          </div>
        </div>
      ) : null}

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) > 0 ? (
        <TrackList
          items={items}
          columns={libraryColumns}
          playingKey={playingKey}
          onActivate={(item) => void QueueActions.playSource({ type: "library", sort: SORT }, item.key)}
          menu={(selection) => <TrackMenuAddItems selection={selection} />}
          scrollId="library-screen-songs"
          topPadding={TOP_HEIGHT}
          bottomPadding={PLAYER_HEIGHT}
        />
      ) : null}
    </section>
  );
}

function RouteComponent() {
  const userStateQuery = useUser();

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
