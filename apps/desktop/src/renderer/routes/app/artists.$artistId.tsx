import { AlbumList } from "#/components/album-list/album-list";
import { AlbumCover } from "#/components/album-list/album-cover";
import { getArtistCredits } from "#/components/utils/artist-links";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { db } from "#/lib/db-renderer";
import { eq, not, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { DiscIcon } from "@phosphor-icons/react";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { artistId } = Route.useParams();

  const artistQuery = useLiveQuery(
    (q) =>
      q
        .from({ artist: db.artists })
        .where(({ artist }) => eq(artist.id, artistId))
        .findOne(),
    [artistId],
  );

  const albumsQuery = useLiveQuery(
    (q) =>
      q
        .from({ album: db.albums })
        .where((v) => eq(v.album.artistId, artistId))
        .orderBy((v) => v.album.year, { direction: "desc" }),
    [artistId],
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

  const matchingSongQuery = useLiveQuery(
    (q) =>
      q
        .from({ song: db.songs })
        .fn.where(({ song }) => getArtistCredits(song).some((artist) => artist.id === artistId))
        .findOne(),
    [artistId],
  );

  const embeddedCredit = [...(albumsQuery.data ?? []), ...(appearsOnQuery.data ?? [])]
    .flatMap((album) => getArtistCredits(album))
    .find((credit) => credit.id === artistId);
  const songCredit = matchingSongQuery.data ? getArtistCredits(matchingSongQuery.data).find((credit) => credit.id === artistId) : undefined;
  const artistName = artistQuery.data?.name ?? embeddedCredit?.name ?? songCredit?.name ?? artistId;

  if (artistQuery.isLoading || albumsQuery.isLoading || appearsOnQuery.isLoading || matchingSongQuery.isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-xl border border-dashed border-border px-6 py-10 text-sm text-muted-foreground">Loading artist...</div>
      </section>
    );
  }

  if (artistQuery.isError || albumsQuery.isError || appearsOnQuery.isError || matchingSongQuery.isError) {
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
      <header className="grid grid-cols-[96px_minmax(0,1fr)] gap-4 border-b border-border/70 bg-card/80 px-4 py-5 md:px-6">
        <AlbumCover
          coverArtPath={artistQuery.data?.coverArtPath}
          instantLoad
          target={{ type: "artist", id: artistId, coverArtId: artistQuery.data?.coverArt ?? null }}
        />
        <div className="min-w-0 self-end">
          <p className="text-sm text-muted-foreground">Artist</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight md:text-3xl">{artistName}</h1>
        </div>
      </header>

      {albumsQuery.data.length > 0 || appearsOnQuery.data.length > 0 ? (
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
            <DiscIcon className="size-5" />
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
