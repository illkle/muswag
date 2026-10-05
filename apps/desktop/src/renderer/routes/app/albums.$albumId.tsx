import { createFileRoute } from "@tanstack/react-router";
import { DiscIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { QueueActions, useQueueManagerState } from "#/queue/queue";
import { db } from "#/data/library";
import { formatDuration, formatMetaLine } from "#/lib/format";
import { useAlbumStatsRefresh } from "#/library/stats-refresh";

import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { albumColumns } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import type { TrackListItem } from "#/components/track-list/types";
import { albumOccurrenceKey } from "@muswag/model";
import { useMemo } from "react";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";

export const Route = createFileRoute("/app/albums/$albumId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { albumId } = Route.useParams();
  useAlbumStatsRefresh(albumId);

  const albumQuery = useLiveQuery((q) =>
    q
      .from({ album: db.albums })
      .where(({ album }) => eq(album.id, albumId))
      .findOne(),
  );

  const songsQuery = useLiveQuery((q) =>
    q
      .from({ song: db.songs })
      .where(({ song }) => eq(song.albumId, albumId))
      .orderBy((q) => [q.song.discNumber, q.song.track]),
  );

  const queueState = useQueueManagerState();

  const discTitles = albumQuery.data?.discTitles;
  const items = useMemo((): TrackListItem[] => {
    const showDiscs = (discTitles?.length ?? 0) > 1;

    return (songsQuery.data ?? []).flatMap((song, index, songs): TrackListItem[] => {
      const track: TrackListItem = { type: "track", key: albumOccurrenceKey(albumId, song.id), song };
      const disc = song.discNumber;
      if (!showDiscs || !disc || songs[index - 1]?.discNumber === disc) return [track];

      const title = discTitles?.find((entry) => entry.disc === disc)?.title;
      return [{ type: "heading", key: `disc:${disc}`, title: `Disc ${disc}`, ...(title ? { subtitle: title } : {}) }, track];
    });
  }, [albumId, discTitles, songsQuery.data]);

  if (albumQuery.isLoading || songsQuery.isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">Loading album details...</div>
      </section>
    );
  }

  if (albumQuery.isError || songsQuery.isError) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Album unavailable</AlertTitle>
            <AlertDescription>The album details could not be read from the local database.</AlertDescription>
          </Alert>
        </div>
      </section>
    );
  }

  if (!albumQuery.data) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-2xl border border-border/70 bg-card/85 px-6 py-14 text-center shadow-xl shadow-primary/5 backdrop-blur">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <DiscIcon className="size-5" />
          </div>
          <div className="space-y-1">
            <p className="font-medium">Album not found.</p>
            <p className="text-sm text-muted-foreground">This album is not currently available in the synced local library.</p>
          </div>
        </div>
      </section>
    );
  }

  const album = albumQuery.data;
  const { genres } = album;
  const primaryGenre = album.genre ?? genres?.[0]?.name ?? null;
  const albumMeta = formatMetaLine([album.year ? String(album.year) : null, `${album.songCount} track${album.songCount === 1 ? "" : "s"}`, formatDuration(album.duration), primaryGenre]);

  const playingKey = queueState.source?.ref.type === "album" && queueState.source.ref.albumId === albumId && queueState.nowPlaying?.origin === "source" ? queueState.nowPlaying.key : null;

  return (
    <>
      <TrackList
        items={items}
        columns={albumColumns}
        playingKey={playingKey}
        onActivate={(item) => void QueueActions.playSource({ type: "album", albumId }, item.key)}
        menu={(selection) => <TrackMenuAddItems selection={selection} />}
        scrollId={"album-" + album.id}
        topPadding={DETAIL_TOP_PADDING}
        bottomPadding={DETAIL_BOTTOM_PADDING}
        topContent={
          <DetailHeader
            title={album.name}
            art={
              <AlbumCover
                coverArtPath={album.coverArtPath}
                className="w-full"
                instantLoad
                target={{
                  type: "album",
                  id: album.id,
                  coverArtId: album.coverArt ?? null,
                }}
              />
            }
          >
            <ArtistLinks
              artist={album.artist}
              artists={album.artists}
              artistId={album.artistId}
              displayArtist={album.displayArtist}
              className="block text-lg text-muted-foreground"
              linkClassName="hover:text-foreground hover:underline"
            />
            {albumMeta ? <p className="text-sm text-muted-foreground">{albumMeta}</p> : null}
          </DetailHeader>
        }
      />
    </>
  );
}
