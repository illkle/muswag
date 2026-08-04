import { createFileRoute } from "@tanstack/react-router";
import { DiscIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { usePlayerCurrentTrackId, usePlayerStatus } from "#/components/player-provider";

import { AlbumCover } from "#/components/album-list/album-cover";
import { AddToPlaylistMenu } from "#/components/playlist/add-to-playlist-menu";
import { ArtistLinks } from "#/components/utils/artist-links";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";
import { SongListRoot } from "#/components/song-list";
import { PlayerIPC } from "#/lib/ipc";
import type { Song } from "@muswag/shared";
import { useAlbumStatsRefresh } from "#/lib/stats-refresh";
import { DETAIL_BOTTOM_PADDING, DETAIL_TOP_PADDING, DetailHeader } from "#/components/detail-header";
import { DebugModal } from "#/components/debug-info";

export const Route = createFileRoute("/app/albums/$albumId")({
  component: RouteComponent,
});

function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) {
    return "-";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatMetaLine(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" • ");
}

function RouteComponent() {
  const { albumId } = Route.useParams();
  useAlbumStatsRefresh(albumId);

  const albumQuery = useLiveQuery(
    (q) =>
      q
        .from({ album: db.albums })
        .where(({ album }) => eq(album.id, albumId))
        .findOne(),
    [albumId],
  );

  const songsQuery = useLiveQuery(
    (q) =>
      q
        .from({ song: db.songs })
        .where(({ song }) => eq(song.albumId, albumId))
        .orderBy((q) => [q.song.discNumber, q.song.track]),
    [albumId],
  );

  const currentTrackId = usePlayerCurrentTrackId();
  const playerStatus = usePlayerStatus();

  if (albumQuery.isLoading || songsQuery.isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">
          Loading album details...
        </div>
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
  const songs = songsQuery.data;
  const queueIndexBySongId = new Map(songs.map((song, index) => [song.id, index]));
  const primaryGenre = album.genre ?? genres?.[0]?.name ?? null;
  const albumMeta = formatMetaLine([
    album.year ? String(album.year) : null,
    `${album.songCount} track${album.songCount === 1 ? "" : "s"}`,
    formatDuration(album.duration),
    primaryGenre,
  ]);

  const onPlay = (song: Song) => {
    const queueIndex = queueIndexBySongId.get(song.id);

    if (queueIndex === undefined) return;

    void PlayerIPC.playQueue({
      queue: songs,
      startIndex: queueIndex,
      context: { type: "album", albumId },
    });
  };

  return (
    <>
      <DebugModal>{JSON.stringify(album, null, 2)}</DebugModal>
      <SongListRoot
        songs={songs}
        discTitles={album.discTitles}
        onSongPlay={onPlay}
        currentTrackID={currentTrackId}
        playerStatus={playerStatus}
        scrollId={"album-" + album.id}
        rowActions={(song) => <AddToPlaylistMenu songIds={[song.id]} />}
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
