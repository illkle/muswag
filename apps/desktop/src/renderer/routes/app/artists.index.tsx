import { createFileRoute } from "@tanstack/react-router";
import { MicrophoneStageIcon, WarningIcon } from "@phosphor-icons/react";
import { useDeferredValue, useState } from "react";

import { ArtistDiscography } from "#/components/artists/artist-discography";
import { ArtistList } from "#/components/artists/artist-list";
import { followAddress, pickInList, startPicking } from "#/components/artists/artist-picking";
import { PageState } from "#/components/page-state";
import { useArtistIndex } from "#/library/artist-index";

export const Route = createFileRoute("/app/artists/")({
  // The artist picked, which going back to the page picks again.
  validateSearch: (search: Record<string, unknown>): { artist?: string } => (typeof search.artist === "string" ? { artist: search.artist } : {}),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [picking, setPicking] = useState(() => startPicking(search.artist));
  const followed = followAddress(picking, search.artist);
  if (followed !== picking) setPicking(followed);
  const { picked } = followed;
  // The albums come after the list, so holding an arrow key goes through the artists without drawing the albums of each on the way.
  const shownPick = useDeferredValue(picked);
  // The artists with albums of their own, and after them those only featured on others' albums.
  const index = useArtistIndex();

  if (index.isPending) return <PageState tone="quiet" title="Loading artists…" />;
  if (index.isError) return <PageState tone="error" icon={<WarningIcon />} title="Artists unavailable" description="The local artist list could not be read." />;
  const { withAlbums, featured } = index.data;
  const listed = withAlbums[0] ?? featured[0];
  if (!listed) {
    return <PageState icon={<MicrophoneStageIcon />} title="No artists yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  // Until one is picked, the first is.
  const isListed = (artistId: string) => withAlbums.some(({ id }) => id === artistId) || featured.some(({ id }) => id === artistId);
  const orFirst = (artistId: string | undefined) => (artistId !== undefined && isListed(artistId) ? artistId : listed.id);
  const selectedId = orFirst(picked);
  const shownId = orFirst(shownPick);

  return (
    <section className="flex h-full w-full min-w-0">
      <ArtistList
        artists={withAlbums}
        featured={featured}
        selectedId={selectedId}
        // Picking an artist replaces the page in the history, so going back leaves the page rather than walking back through the artists.
        onSelect={(artist) => {
          const next = pickInList(followed, artist);
          setPicking(next.state);
          if (next.navigate) void navigate({ search: { artist }, replace: true });
        }}
        className="w-64 shrink-0 border-r"
      />
      <div className="min-w-0 flex-1">
        {/* A list of its own for each artist, which starts at the top. */}
        <ArtistDiscography key={shownId} artistId={shownId} />
      </div>
    </section>
  );
}
