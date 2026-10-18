import { AlbumList } from "#/components/album-list/album-list";
import { AlbumCover } from "#/components/album-list/album-cover";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { getArtistCredits } from "#/components/utils/artist-links";
import { PageState } from "#/components/page-state";
import { db } from "#/data/library";
import { useArtistAppearances } from "#/library/artist-appearances";
import { formatMetaLine } from "#/lib/format";
import { eq, inArray, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { WarningIcon } from "@phosphor-icons/react";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

// `inArray` with an empty list is not a query TanStack DB can run, so an id no album has stands in for none.
const NO_ALBUMS = [" "];

function RouteComponent() {
  const { artistId } = Route.useParams();

  const artistQuery = useLiveQuery({
    queryKey: ["artist", artistId],
    query: (q) =>
      q
        .from({ artist: db.artists })
        .where(({ artist }) => eq(artist.id, artistId))
        .findOne(),
  });

  const albumsQuery = useLiveQuery({
    queryKey: ["artist-albums", artistId],
    query: (q) =>
      q
        .from({ album: db.albums })
        .where((v) => eq(v.album.artistId, artistId))
        .orderBy((v) => v.album.year, { direction: "desc", nulls: "last" }),
  });

  const appearancesQuery = useArtistAppearances(artistId);
  const appearsOnIds = appearancesQuery.data?.albumIds.length ? appearancesQuery.data.albumIds : NO_ALBUMS;
  const appearsOnQuery = useLiveQuery({
    queryKey: ["artist-appears-on", appearsOnIds],
    query: (q) =>
      q
        .from({ album: db.albums })
        .where(({ album }) => inArray(album.id, [...appearsOnIds]))
        .orderBy((v) => v.album.year, { direction: "desc", nulls: "last" }),
  });

  if (artistQuery.isLoading || albumsQuery.isLoading || appearancesQuery.isPending || appearsOnQuery.isLoading) return <PageState tone="quiet" title="Loading artist…" />;
  if (artistQuery.isError || albumsQuery.isError || appearancesQuery.isError || appearsOnQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Artist unavailable" description="The artist could not be read from the local database." />;
  }

  const albums = albumsQuery.data;
  const appearsOn = appearsOnQuery.data;
  // An artist may have no row of its own, and is then named as an album or a song credits it.
  const credited = [...albums, ...appearsOn].flatMap((album) => getArtistCredits(album)).find((credit) => credit.id === artistId)?.name;
  const artistName = artistQuery.data?.name ?? credited ?? appearancesQuery.data.name ?? artistId;
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
