import { createFileRoute } from "@tanstack/react-router";
import { VinylRecordIcon, WarningIcon } from "@phosphor-icons/react";

import { AlbumList } from "#/components/album-list/album-list";
import { PageState } from "#/components/page-state";
import { useAlbumRows } from "#/library/album-rows";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

function RouteComponent() {
  // Newest first, albums with no year after the dated ones, read from main as the grid shows them.
  const { albums, isError } = useAlbumRows();

  if (!albums && isError) return <PageState tone="error" icon={<WarningIcon />} title="Albums unavailable" description="The albums could not be read from the local library. Trying again…" />;
  if (!albums) return <PageState tone="quiet" title="Loading albums…" />;
  if (albums.count === 0) {
    return <PageState icon={<VinylRecordIcon />} title="No albums yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  return <AlbumList rows={albums} scrollId="library-screen-albums" rememberScroll className="h-full" />;
}
