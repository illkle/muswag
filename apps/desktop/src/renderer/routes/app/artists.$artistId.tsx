import { useMemo } from "react";

import { AlbumList } from "#/components/album-list";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { db } from "#/lib/db-renderer";
import { eq, inArray, not, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { artistId } = Route.useParams();

  const albumsQuery = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((v) => eq(v.album.artistId, artistId))
      .orderBy((v) => v.album.year, { direction: "desc" }),
  );

  const appearsOnQuery = useLiveQuery(
    (q) =>
      q
        .from({ album: db.albums })
        .where((v) => not(eq(v.album.artistId, artistId)))
        .innerJoin({ song: db.songs }, ({ album, song }) => eq(album.id, song.albumId))
        .fn.where(({ song }) => song.artists?.some((artist) => artist.id === artistId))
        .select(({ album }) => album)
        .orderBy((v) => v.album.year, { direction: "desc" })
        .distinct(),
    [artistId],
  );

  const artistName = artistId;

  if (albumsQuery.isLoading || appearsOnQuery.isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading artist...</div>
      </section>
    );
  }

  if (albumsQuery.isError || appearsOnQuery.isError) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Artist unavailable</AlertTitle>
            <AlertDescription>The artist could not be read from the local database.</AlertDescription>
          </Alert>
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full w-full flex-col">
      <header className="border-b border-border/70 bg-card/80 px-4 py-5 md:px-6">
        <p className="text-sm text-muted-foreground">Artist</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{artistName}</h1>
      </header>

      {albumsQuery.data.length > 0 ? (
        <AlbumList
          sections={[
            { id: "albums", title: "Albums", albums: albumsQuery.data },
            { id: "appears-on", title: "Appears On", albums: appearsOnQuery.data },
          ]}
          scrollId={"artist-" + artistId}
          className="min-h-0 flex-1"
        />
      ) : (
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-14">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Disc3 className="size-5" />
          </div>
          <div className="space-y-1 text-center">
            <p className="font-medium">No albums for this artist.</p>
            <p className="text-sm text-muted-foreground">No matching albums are currently available in the synced local library.</p>
          </div>
        </div>
      )}
    </section>
  );
}
