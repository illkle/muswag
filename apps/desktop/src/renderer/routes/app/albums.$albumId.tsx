import { createFileRoute, useElementScrollRestoration } from "@tanstack/react-router";
import { Disc3 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { usePlayerCurrentTrackId, usePlayerStatus } from "#/components/player-provider";

import { AlbumCover } from "#/components/album-cover";
import { ArtistLinks } from "#/components/artist-links";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { db } from "#/lib/db-renderer";
import { SongListRoot } from "#/components/song-list";
import { PlayerIPC } from "#/lib/ipc";
import type { Song } from "@muswag/shared";

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

  const scrollRestorationId = "album-" + albumId;
  useElementScrollRestoration({
    id: scrollRestorationId,
  });

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
            <Disc3 className="size-5" />
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
    });
  };

  return (
    <section data-scroll-restoration-id={scrollRestorationId} className="flex h-full w-full flex-col overflow-auto">
      <header className="border-b border-border/70 bg-card/80 grid gap-4 p-4 md:grid-cols-[160px_minmax(0,1fr)] md:p-6">
        <AlbumCover coverArtPath={album.coverArtPath} instantLoad />

        <div className="min-w-0 self-end">
          <ArtistLinks
            artist={album.artist}
            artistId={album.artistId}
            artists={album.artists}
            displayArtist={album.displayArtist}
            className="block truncate text-sm text-muted-foreground"
            linkClassName="hover:text-foreground hover:underline"
          />

          <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{album.name}</h1>
          {albumMeta ? <p className="mt-2 text-sm text-muted-foreground">{albumMeta}</p> : null}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <SongListRoot
          songs={songs}
          discTitles={album.discTitles}
          onSongPlay={onPlay}
          currentTrackID={currentTrackId}
          playerStatus={playerStatus}
          scrollId={"album-" + album.id}
        />
      </div>
    </section>
  );
}
