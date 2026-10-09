import { AlbumList } from "#/components/album-list/album-list";
import { AlbumCover } from "#/components/album-list/album-cover";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { getArtistCredits } from "#/components/utils/artist-links";
import { PageState } from "#/components/page-state";
import { db } from "#/data/library";
import { formatMetaLine } from "#/lib/format";
import { eq, not, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { WarningIcon } from "@phosphor-icons/react";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { artistId } = Route.useParams();

  const artistQuery = useLiveQuery((q) =>
    q
      .from({ artist: db.artists })
      .where(({ artist }) => eq(artist.id, artistId))
      .findOne(),
  );

  const albumsQuery = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where((v) => eq(v.album.artistId, artistId))
      .orderBy((v) => v.album.year, { direction: "desc", nulls: "last" }),
  );

  // Every song of the other artists' albums is looked at for a credit of this one, which TanStack DB
  // cannot see into: the key tells it which artist the query is for.
  const appearsOnQuery = useLiveQuery({
    queryKey: ["artist-appears-on", artistId],
    query: (q) =>
      q
        .from({ album: db.albums })
        .where((v) => not(eq(v.album.artistId, artistId)))
        .innerJoin({ song: db.songs }, ({ album, song }) => eq(album.id, song.albumId))
        .fn.where(({ song }) => song.artists?.some((artist) => artist.id === artistId))
        // With the song's credits: an artist credited only on tracks has no row of its own, and is named there.
        .select(({ album, song }) => ({ album, credits: song.artists }))
        .orderBy((v) => v.album.year, { direction: "desc", nulls: "last" }),
  });

  if (artistQuery.isLoading || albumsQuery.isLoading || appearsOnQuery.isLoading) return <PageState tone="quiet" title="Loading artist…" />;
  if (artistQuery.isError || albumsQuery.isError || appearsOnQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Artist unavailable" description="The artist could not be read from the local database." />;
  }

  const albums = albumsQuery.data;
  // One row for each song the artist is on, so an album comes once for each of them.
  const appearsOn = [...new Map(appearsOnQuery.data.map(({ album }) => [album.id, album])).values()];
  // An artist may have no row of its own, and is then named as an album or a song credits it.
  const credits = [...[...albums, ...appearsOn].flatMap((album) => getArtistCredits(album)), ...appearsOnQuery.data.flatMap((song) => song.credits ?? [])];
  const artistName = artistQuery.data?.name ?? credits.find((credit) => credit.id === artistId)?.name ?? artistId;
  const artistMeta = formatMetaLine([
    albums.length > 0 ? `${albums.length} album${albums.length === 1 ? "" : "s"}` : null,
    appearsOn.length > 0 ? `${appearsOn.length} appearance${appearsOn.length === 1 ? "" : "s"}` : null,
  ]);

  return (
    <section className="flex h-full w-full flex-col">
      <AlbumList
        sections={[
          { id: "albums", title: "Albums", albums, hideArtist: true },
          { id: "appears-on", title: "Appears On", albums: appearsOn },
        ]}
        scrollId={"artist-" + artistId}
        className="min-h-0 flex-1"
        topPadding={DETAIL_TOP_PADDING}
        bottomPadding={DETAIL_BOTTOM_PADDING}
        topContent={
          // The grid below pads its tiles by as much again, which puts the artwork on the edge of the covers.
          <DetailHeader
            className="px-2"
            title={artistName}
            art={
              <AlbumCover
                className="w-full"
                instantLoad
                target={{
                  type: "artist",
                  id: artistId,
                  coverArtId: artistQuery.data?.coverArt ?? null,
                }}
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
