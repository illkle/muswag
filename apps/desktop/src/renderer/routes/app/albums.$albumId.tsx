import { createFileRoute } from "@tanstack/react-router";
import { DiscIcon, PlayIcon, WarningIcon } from "@phosphor-icons/react";

import { PageState } from "#/components/page-state";
import { Button } from "#/components/ui/button";
import { QueueActions, usePlayingKey } from "#/queue/queue";
import { db } from "#/data/library";
import { formatDuration, formatMetaLine } from "#/lib/format";
import { failureNotice } from "#/lib/notify";
import { useAlbumRefresh } from "#/library/page-refresh";
import { creditedAsTheirAlbums, discHeading } from "#/library/album-tracks";

import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks } from "#/components/utils/artist-links";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { albumColumns, albumColumnsWithoutArtist } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import { isTrackItem, type TrackListItem } from "#/components/track-list/types";
import { ALBUM_ORDER, albumOccurrenceKey } from "@muswag/model";
import { useMemo } from "react";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";

export const Route = createFileRoute("/app/albums/$albumId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { albumId } = Route.useParams();
  useAlbumRefresh(albumId);

  // The keys name what each query reads, so a render builds no query unless the album is another one.
  const albumQuery = useLiveQuery({
    queryKey: ["album", albumId],
    query: (q) =>
      q
        .from({ album: db.albums })
        .where(({ album }) => eq(album.id, albumId))
        .findOne(),
  });

  const songsQuery = useLiveQuery({
    queryKey: ["album-songs", albumId],
    query: (q) =>
      q
        .from({ song: db.songs })
        .where(({ song }) => eq(song.albumId, albumId))
        // The order main plays the album in. Nulls first is what SQLite does too.
        .orderBy(({ song }) => ALBUM_ORDER.map((column) => song[column]), { stringSort: "lexical", nulls: "first" }),
  });

  const playingKey = usePlayingKey((ref) => ref.type === "album" && ref.albumId === albumId);

  const discTitles = albumQuery.data?.discTitles;
  const items = useMemo(
    (): TrackListItem[] =>
      (songsQuery.data ?? []).flatMap((song, index, songs): TrackListItem[] => {
        const track: TrackListItem = { type: "track", key: albumOccurrenceKey(albumId, song.id), song };
        const heading = discHeading({ id: albumId, discTitles }, song, songs[index - 1]);
        return heading ? [heading, track] : [track];
      }),
    [albumId, discTitles, songsQuery.data],
  );

  if (albumQuery.isLoading || songsQuery.isLoading) return <PageState tone="quiet" title="Loading album…" />;
  if (albumQuery.isError || songsQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Album unavailable" description="The album could not be read from the local database." />;
  }
  if (!albumQuery.data) return <PageState icon={<DiscIcon />} title="Album not found" description="This album is not in the synced local library." />;

  const album = albumQuery.data;
  const { genres } = album;
  const primaryGenre = album.genre ?? genres?.[0]?.name ?? null;
  const albumMeta = formatMetaLine([album.year ? String(album.year) : null, `${album.songCount} track${album.songCount === 1 ? "" : "s"}`, formatDuration(album.duration), primaryGenre]);

  const columns = creditedAsTheirAlbums(songsQuery.data ?? [], [album]) ? albumColumnsWithoutArtist : albumColumns;
  const firstKey = items.find(isTrackItem)?.key;

  const playFrom = (key: string) => void QueueActions.playSource({ type: "album", albumId }, key).catch(failureNotice("The album could not be played."));

  return (
    <>
      <TrackList
        items={items}
        columns={columns}
        playingKey={playingKey}
        showHeader
        onActivate={(item) => playFrom(item.key)}
        menu={(selection) => <TrackMenuAddItems selection={selection} />}
        scrollId={"album-" + album.id}
        topPadding={DETAIL_TOP_PADDING}
        bottomPadding={DETAIL_BOTTOM_PADDING}
        topContent={
          <DetailHeader
            title={album.name}
            art={
              <AlbumCover
                className="w-full"
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

            <div className="mt-2 flex items-center gap-1">
              <Button className="h-10 w-32 gap-2 text-base" disabled={!firstKey} onClick={() => firstKey && playFrom(firstKey)}>
                <PlayIcon weight="fill" className="size-5" />
                Play
              </Button>
            </div>
          </DetailHeader>
        }
      />
    </>
  );
}
