
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { useUser } from "#/lib/queries";
import { useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";
import { SongListRoot, SongRenderSongsList } from "#/components/song-list";
import { AddToPlaylistMenu } from "#/components/playlist/add-to-playlist-menu";

export const Route = createFileRoute("/app/songs/")({
  component: RouteComponent,
});

function LibraryScreen() {
  const songsQuery = useLiveQuery((q) => q.from({ songs: db.songs }));

  return (
    <section className="flex h-full w-full flex-col">
      {songsQuery.isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading albums...</div>
      ) : null}

      {songsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>{"The local album list could not be read."}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) === 0 ? (
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Disc3 className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">No albums in the local database yet.</p>
            <p className="text-sm text-muted-foreground">Use the server control in the sidebar to fetch your server library.</p>
          </div>
        </div>
      ) : null}

      {!songsQuery.isLoading && !songsQuery.isError && (songsQuery.data?.length ?? 0) > 0 ? (
        <SongListRoot
          currentTrackID={""}
          playerStatus={null}
          songs={songsQuery.data ?? []}
          scrollId="library-screen-songs"
          onSongPlay={() => null}
          SongComponent={SongRenderSongsList}
          rowActions={(song) => <AddToPlaylistMenu songIds={[song.id]} />}
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
