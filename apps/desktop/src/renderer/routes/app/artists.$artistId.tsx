import { AlbumList } from "#/components/album-list/album-list";
import { AlbumCover } from "#/components/album-list/album-cover";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { getArtistCredits } from "#/components/utils/artist-links";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { db } from "#/lib/db-renderer";
import { eq, not, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

function formatMetaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
}

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

  const albums = albumsQuery.data;
  const appearsOn = appearsOnQuery.data;
  const artistMeta = formatMetaLine([
    albums.length > 0 ? `${albums.length} album${albums.length === 1 ? "" : "s"}` : null,
    appearsOn.length > 0 ? `${appearsOn.length} appearance${appearsOn.length === 1 ? "" : "s"}` : null,
  ]);

  return (
    <section className="flex h-full w-full flex-col">
      <AlbumList
        sections={[
          { id: "albums", title: "Albums", albums },
          { id: "appears-on", title: "Appears On", albums: appearsOn },
        ]}
        scrollId={"artist-" + artistId}
        className="min-h-0 flex-1"
        topPadding={DETAIL_TOP_PADDING}
        bottomPadding={DETAIL_BOTTOM_PADDING}
        topContent={
          // The grid below pads its rows by 10px, so the artwork has to sit on the same edge.
          <DetailHeader
            className="px-2.5"
            title={artistName}
            art={
              <AlbumCover
                coverArtPath={artistQuery.data?.coverArtPath}
                className="w-full"
                instantLoad
                target={{ type: "artist", id: artistId, coverArtId: artistQuery.data?.coverArt ?? null }}
              />
            }
          >
            <p className="text-sm text-muted-foreground">{artistMeta || "No albums in the synced local library."}</p>
          </DetailHeader>
        }
      />
    </section>
  );
}
