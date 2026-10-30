import { AlbumList } from "#/components/album-list/album-list";
import { AlbumCover } from "#/components/album-list/album-cover";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { ShuffleButton } from "#/components/shuffle-button";
import { getArtistCredits } from "#/components/utils/artist-links";
import { PageState } from "#/components/page-state";
import { useMainRead } from "#/data/main-read";
import { LibraryActions } from "#/library/actions";
import { useArtistAppearances } from "#/library/artist-appearances";
import { formatMetaLine } from "#/lib/format";
import type { LibraryAlbum } from "@muswag/model";
import { createFileRoute } from "@tanstack/react-router";
import { WarningIcon } from "@phosphor-icons/react";

export const Route = createFileRoute("/app/artists/$artistId")({
  component: RouteComponent,
});

const NO_ALBUMS: ReadonlyArray<LibraryAlbum> = [];

function RouteComponent() {
  const { artistId } = Route.useParams();

  // The artist's row and its own albums, newest first.
  const artistQuery = useMainRead({ queryKey: ["artist", artistId], tables: ["artists", "albums"], read: () => LibraryActions.artist(artistId) });

  const appearancesQuery = useArtistAppearances(artistId);
  const appearsOnIds = appearancesQuery.data?.albumIds ?? [];
  const appearsOnQuery = useMainRead({
    queryKey: ["albums-by-ids", appearsOnIds],
    tables: ["albums"],
    read: () => (appearsOnIds.length > 0 ? LibraryActions.albumsByIds(appearsOnIds) : Promise.resolve([])),
  });

  if (artistQuery.isPending || appearancesQuery.isPending || appearsOnQuery.isPending) return <PageState tone="quiet" title="Loading artist…" />;
  if (artistQuery.isError || appearancesQuery.isError || appearsOnQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Artist unavailable" description="The artist could not be read from the local database." />;
  }

  const albums = artistQuery.data.albums;
  const appearsOn = appearsOnQuery.data ?? NO_ALBUMS;
  // An artist may have no row of its own, and is then named as an album or a song credits it.
  const credited = [...albums, ...appearsOn].flatMap((album) => getArtistCredits(album)).find((credit) => credit.id === artistId)?.name;
  const artistName = artistQuery.data.artist?.name ?? credited ?? appearancesQuery.data.name ?? artistId;
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
                  coverArtId: artistQuery.data.artist?.coverArt ?? null,
                }}
                placeholder={{ title: artistName }}
              />
            }
          >
            <p className="text-sm text-muted-foreground">{artistMeta || "No albums in the synced local library."}</p>
            <div className="mt-2">
              <ShuffleButton source={{ type: "artist", artistId }} disabled={!artistMeta} />
            </div>
          </DetailHeader>
        }
      />
    </section>
  );
}
