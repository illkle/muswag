import { createFileRoute } from "@tanstack/react-router";
import { MicrophoneStageIcon, WarningIcon } from "@phosphor-icons/react";
import { eq, useLiveQuery } from "@tanstack/react-db";

import { ArtistDiscography } from "#/components/artists/artist-discography";
import { ArtistList } from "#/components/artists/artist-list";
import { PageState } from "#/components/page-state";
import { db } from "#/data/library";

export const Route = createFileRoute("/app/artists/")({
  // The artist picked, which going back to the page picks again.
  validateSearch: (search: Record<string, unknown>): { artist?: string } => (typeof search.artist === "string" ? { artist: search.artist } : {}),
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Only the artists with albums of their own: one credited only on tracks of others' albums has nothing to show here.
  const artistsQuery = useLiveQuery((q) =>
    q
      .from({ artist: db.artists })
      .innerJoin({ album: db.albums }, ({ artist, album }) => eq(artist.id, album.artistId))
      .select(({ artist }) => ({ ...artist }))
      .distinct()
      .orderBy(({ artist }) => artist.name, { stringSort: "locale", localeOptions: { sensitivity: "base", numeric: true } }),
  );
  const artists = artistsQuery.data;

  if (artistsQuery.isLoading) return <PageState tone="quiet" title="Loading artists…" />;
  if (artistsQuery.isError) return <PageState tone="error" icon={<WarningIcon />} title="Artists unavailable" description="The local artist list could not be read." />;
  if (artists.length === 0) {
    return <PageState icon={<MicrophoneStageIcon />} title="No artists yet" description="Use the server control in the sidebar to fetch your server library." />;
  }

  // Until one is picked, the first is.
  const selectedId = search.artist !== undefined && artists.some(({ id }) => id === search.artist) ? search.artist : artists[0]!.id;

  return (
    <section className="flex h-full w-full min-w-0">
      <ArtistList
        artists={artists}
        selectedId={selectedId}
        // Picking an artist replaces the page in the history, so going back leaves the page rather than walking back through the artists.
        onSelect={(artist) => void navigate({ search: { artist }, replace: true })}
        className="w-64 shrink-0 border-r"
      />
      <div className="min-w-0 flex-1">
        {/* A list of its own for each artist, which starts at the top. */}
        <ArtistDiscography key={selectedId} artistId={selectedId} />
      </div>
    </section>
  );
}
