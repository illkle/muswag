import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { useUser } from "#/session/session";
import { db } from "#/data/library";
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

function LibraryScreen() {
  const songsQuery = useLiveQuery((q) => q.from({ songs: db.songs }));
  const items = useMemo((): TrackListItem[] => (songsQuery.data ?? []).map((song) => ({ type: "track", key: song.id, song })), [songsQuery.data]);

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
