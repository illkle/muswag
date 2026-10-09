import { createFileRoute, Navigate } from "@tanstack/react-router";
import { VinylRecordIcon, WarningIcon } from "@phosphor-icons/react";

import { AlbumList } from "#/components/album-list/album-list";
import { PageState } from "#/components/page-state";
import { useUser } from "#/session/session";
import { db } from "#/data/library";
import { useLiveQuery } from "@tanstack/react-db";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

function LibraryScreen() {
  // Albums with no year go after the dated ones rather than ahead of the newest.
  const albumsQuery = useLiveQuery((q) => q.from({ albums: db.albums }).orderBy((v) => v.albums.year, { direction: "desc", nulls: "last" }));
  const albums = albumsQuery.data ?? [];

  if (albumsQuery.isLoading) return <PageState tone="quiet" title="Loading albums…" />;
  if (albumsQuery.isError) return <PageState tone="error" icon={<WarningIcon />} title="Albums unavailable" description="The local album list could not be read." />;
  if (albums.length === 0) {
    return <PageState icon={<VinylRecordIcon />} title="No albums yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  return <AlbumList albums={albums} scrollId="library-screen-albums" rememberScroll className="h-full" />;
}

function RouteComponent() {
  const userStateQuery = useUser();

  if (!userStateQuery.data) {
    return <Navigate to="/" />;
  }

  return <LibraryScreen />;
}
