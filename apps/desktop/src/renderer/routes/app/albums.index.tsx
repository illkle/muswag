import { createFileRoute, Navigate } from "@tanstack/react-router";
import { DiscIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";

import { AlbumList } from "#/components/album-list/album-list";
import { useUser } from "#/lib/queries";
import { useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

function LibraryScreen() {
  const albumsQuery = useLiveQuery((q) => q.from({ albums: db.albums }).orderBy((v) => v.albums.year, { direction: "desc" }));

  return (
    <section className="flex h-full w-full flex-col">
      {albumsQuery.isLoading ? (
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading albums...</div>
      ) : null}

      {albumsQuery.isError ? (
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Albums unavailable</AlertTitle>
            <AlertDescription>{"The local album list could not be read."}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) === 0 ? (
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <DiscIcon className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">No albums in the local database yet.</p>
            <p className="text-sm text-muted-foreground">Use the server control in the sidebar to fetch your server library.</p>
          </div>
        </div>
      ) : null}

      {!albumsQuery.isLoading && !albumsQuery.isError && (albumsQuery.data?.length ?? 0) > 0 ? (
        <AlbumList albums={albumsQuery.data ?? []} scrollId="library-screen-albums" className="min-h-0 flex-1" />
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
