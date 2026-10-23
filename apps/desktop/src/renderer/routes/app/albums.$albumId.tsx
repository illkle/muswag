import { createFileRoute } from "@tanstack/react-router";
import { DiscIcon, PlayIcon, WarningIcon } from "@phosphor-icons/react";

import { PageState } from "#/components/page-state";
import { Button } from "#/components/ui/button";
import { QueueActions, usePlayingKey } from "#/queue/queue";
import { db } from "#/data/library";
import { formatDuration, formatMetaLine } from "#/lib/format";
import { failureNotice } from "#/lib/notify";
import { useAlbumRefresh } from "#/library/page-refresh";

import { AlbumCover } from "#/components/album-list/album-cover";
import { ArtistLinks, getArtistCredits } from "#/components/utils/artist-links";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { albumColumns, albumColumnsWithoutArtist } from "#/components/track-list/columns";
import { TrackList } from "#/components/track-list/track-list";
import { TrackMenuAddItems } from "#/components/track-list/track-menu";
import { isTrackItem, type TrackListItem } from "#/components/track-list/types";
import { ALBUM_ORDER, albumOccurrenceKey } from "@muswag/model";
import { useMemo } from "react";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { CoverColoursScope } from "#/components/cover-colours";
import { BrandGlow } from "#/components/brand-glow";

export const Route = createFileRoute("/app/albums/$albumId")({
  component: RouteComponent,
});

/** The artists something is credited to, as one comparable line. */
const creditLine = (credited: Parameters<typeof getArtistCredits>[0]) =>
  getArtistCredits(credited)
    .map(({ name }) => name)
    .join(", ");

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

  if (albumQuery.isLoading || songsQuery.isLoading) return <PageState tone="quiet" title="Loading album…" />;
  if (albumQuery.isError || songsQuery.isError) {
    return <PageState tone="error" icon={<WarningIcon />} title="Album unavailable" description="The album could not be read from the local database." />;
  }
  if (!albumQuery.data) return <PageState icon={<DiscIcon />} title="Album not found" description="This album is not in the synced local library." />;

  const album = albumQuery.data;
  const { genres } = album;
  const primaryGenre = album.genre ?? genres?.[0]?.name ?? null;
  const albumMeta = formatMetaLine([album.year ? String(album.year) : null, `${album.songCount} track${album.songCount === 1 ? "" : "s"}`, formatDuration(album.duration), primaryGenre]);

  // Naming the artist on every row only says something when a track is credited differently from the album.
  const albumCredit = creditLine(album);
  const columns = (songsQuery.data ?? []).every((song) => creditLine(song) === albumCredit) ? albumColumnsWithoutArtist : albumColumns;
  const firstKey = items.find(isTrackItem)?.key;

  const playFrom = (key: string) => void QueueActions.playSource({ type: "album", albumId }, key).catch(failureNotice("The album could not be played."));

  return (
    // The cover's colours reach the playing row, the play button and the glow through the custom properties set here.
    <CoverColoursScope colours={album.coverColours}>
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
          <DetailHeader title={album.name} art={<AlbumCover className="w-full" target={{ type: "album", id: album.id, coverArtId: album.coverArt ?? null }} />}>
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
              <Button className="relative isolate h-10 w-32 gap-2 text-base" disabled={!firstKey} onClick={() => firstKey && playFrom(firstKey)}>
                <BrandGlow />
                <PlayIcon weight="fill" className="size-5" />
                Play
              </Button>
            </div>
          </DetailHeader>
        }
      />
    </CoverColoursScope>
  );
}
