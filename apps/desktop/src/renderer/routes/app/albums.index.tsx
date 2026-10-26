import { createFileRoute } from "@tanstack/react-router";
import { VinylRecordIcon, WarningIcon } from "@phosphor-icons/react";

import { AlbumControls } from "#/components/album-list/album-controls";
import { AlbumList } from "#/components/album-list/album-list";
import { PageState } from "#/components/page-state";
import { useAlbumRows } from "#/library/album-rows";
import { TILE_SIZES, useAlbumView } from "#/library/album-view";

export const Route = createFileRoute("/app/albums/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { sort, tileSize } = useAlbumView();
  // Read from main as the grid shows them, in the order the controls set.
  const { albums, isError } = useAlbumRows(sort);

  return (
    <section className="relative h-full w-full">
      {/* Over the top bar at the left of the page, level with the search. */}
      <div className="absolute top-1.5 left-3 z-20">
        <AlbumControls className="app-no-drag-region" />
      </div>
      <Albums albums={albums} isError={isError} sort={sort} tileSize={tileSize} />
    </section>
  );
}

function Albums({ albums, isError, sort, tileSize }: ReturnType<typeof useAlbumRows> & ReturnType<typeof useAlbumView>) {
  if (!albums && isError) return <PageState tone="error" icon={<WarningIcon />} title="Albums unavailable" description="The albums could not be read from the local library. Trying again…" />;
  if (!albums) return <PageState tone="quiet" title="Loading albums…" />;
  if (albums.count === 0) {
    return <PageState icon={<VinylRecordIcon />} title="No albums yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  // Another order starts at the top, and each comes back to where it was.
  return <AlbumList key={sort} rows={albums} tileWidth={TILE_SIZES[tileSize]} scrollId={`library-screen-albums-${sort}`} rememberScroll className="h-full" />;
}
