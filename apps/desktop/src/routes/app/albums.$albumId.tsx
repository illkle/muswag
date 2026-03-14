import type { SongRecord } from "@muswag/shared";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Disc3, LoaderCircle, PauseCircle, PlayCircle } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { usePlayerCurrentTrackId, usePlayerStatus } from "#/components/player-provider";
import { albumDetailQueryOptions } from "#/lib/app-state";
import { getErrorMessage } from "#/lib/err";
import { cn } from "#/lib/utils";
import { PlayerIPC } from "#/lib/db";
import type { PlayerQueueItem, PlayerStatus } from "#/shared/player";

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
  const albumQuery = useQuery(albumDetailQueryOptions(albumId));

  const currentTrackId = usePlayerCurrentTrackId();
  const playerStatus = usePlayerStatus();

  if (albumQuery.isLoading) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6 rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">
          Loading album details...
        </div>
      </section>
    );
  }

  if (albumQuery.isError) {
    return (
      <section className="flex h-full w-full flex-col">
        <div className="m-6">
          <Alert variant="destructive">
            <AlertTitle>Album unavailable</AlertTitle>
            <AlertDescription>
              {getErrorMessage(
                albumQuery.error,
                "The album details could not be read from the local database.",
              )}
            </AlertDescription>
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
            <p className="text-sm text-muted-foreground">
              This album is not currently available in the synced local library.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const { album, artists, discTitles, genres, songs } = albumQuery.data;
  const albumArtists = artists.length > 0 ? artists.map((artist) => artist.name) : [];
  const headlineArtist =
    album.displayArtist ??
    album.artist ??
    (albumArtists.length > 0 ? albumArtists.join(", ") : "Unknown artist");
  const discTitlesByNumber = new Map(
    discTitles.map((discTitle) => [discTitle.disc, discTitle.title]),
  );
  const songsByDisc = new Map<number, typeof songs>();

  for (const song of songs) {
    const discNumber = song.discNumber ?? 1;
    const currentSongs = songsByDisc.get(discNumber) ?? [];
    currentSongs.push(song);
    songsByDisc.set(discNumber, currentSongs);
  }

  const discSections = [...songsByDisc.entries()]
    .sort(([left], [right]) => left - right)
    .map(([discNumber, discSongs]) => ({
      discNumber,
      discTitle: discTitlesByNumber.get(discNumber) ?? null,
      songs: discSongs,
    }));
  const albumQueue = songs.map(toQueueItem);
  const queueIndexBySongId = new Map(albumQueue.map((song, index) => [song.id, index]));
  const primaryGenre = album.genre ?? genres[0]?.value ?? null;
  const albumMeta = formatMetaLine([
    album.year ? String(album.year) : null,
    `${album.songCount} track${album.songCount === 1 ? "" : "s"}`,
    formatDuration(album.duration),
    primaryGenre,
  ]);

  return (
    <section className="flex h-full w-full flex-col">
      <header className="border-b border-border/70 bg-card/80">
        <div className="grid gap-4 p-4 md:grid-cols-[160px_minmax(0,1fr)] md:p-6">
          <div className="flex aspect-square w-full max-w-[10rem] items-center justify-center rounded-2xl border border-dashed border-border bg-muted/35 text-muted-foreground">
            <Disc3 className="size-14" />
          </div>

          <div className="min-w-0 self-end">
            <p className="truncate text-sm text-muted-foreground">{headlineArtist}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight md:text-3xl">{album.name}</h1>
            {albumMeta ? <p className="mt-2 text-sm text-muted-foreground">{albumMeta}</p> : null}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {discSections.length === 0 ? (
          <div className="m-6 rounded-2xl border border-dashed border-border bg-muted/35 px-6 py-12 text-sm text-muted-foreground">
            No songs are available for this album yet.
          </div>
        ) : null}

        {discSections.length > 0 ? (
          <div className="divide-y divide-border/70">
            {discSections.map((discSection) => {
              const showDiscHeader = discSections.length > 1 || Boolean(discSection.discTitle);

              return (
                <div key={discSection.discNumber}>
                  {showDiscHeader ? (
                    <div className="flex items-center justify-between bg-muted/35 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Disc {discSection.discNumber}</p>
                        {discSection.discTitle ? (
                          <p className="truncate text-sm text-muted-foreground">
                            {discSection.discTitle}
                          </p>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {discSection.songs.length} track{discSection.songs.length === 1 ? "" : "s"}
                      </p>
                    </div>
                  ) : null}

                  <div className="divide-y divide-border/60">
                    {discSection.songs.map((song) => {
                      const queueIndex = queueIndexBySongId.get(song.id) ?? 0;
                      const isActive = currentTrackId === song.id;

                      return (
                        <button
                          key={song.id}
                          type="button"
                          className={cn(
                            "grid w-full gap-3 px-4 py-3 text-left transition-colors md:grid-cols-[56px_minmax(0,1fr)_minmax(120px,0.45fr)_72px] md:items-center",
                            "hover:bg-muted/55 focus-visible:bg-muted/60 focus-visible:outline-none",
                            isActive && "bg-primary/6",
                          )}
                          onClick={() => {
                            void PlayerIPC.playQueue({
                              queue: albumQueue,
                              startIndex: queueIndex,
                            });
                          }}
                        >
                          <div className="text-sm font-medium text-muted-foreground">
                            {isActive ? renderTrackStateIcon(playerStatus) : (song.track ?? "•")}
                          </div>
                          <div className="min-w-0">
                            <p className={cn("truncate font-medium", isActive && "text-primary")}>
                              {song.title}
                            </p>
                            {song.comment ? (
                              <p className="truncate text-sm text-muted-foreground">
                                {song.comment}
                              </p>
                            ) : null}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {song.displayArtist ?? song.artist ?? "Unknown artist"}
                          </div>
                          <div className="text-sm font-medium text-muted-foreground md:text-right">
                            {formatDuration(song.duration)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function toQueueItem(song: SongRecord): PlayerQueueItem {
  return {
    id: song.id,
    title: song.title,
    albumId: song.albumId ?? null,
    album: song.album ?? null,
    artist: song.artist ?? null,
    displayArtist: song.displayArtist ?? null,
    duration: song.duration ?? null,
    discNumber: song.discNumber ?? null,
    track: song.track ?? null,
  };
}

function renderTrackStateIcon(status: PlayerStatus): ReactNode {
  if (status === "loading") {
    return <LoaderCircle className="size-4 animate-spin text-primary" />;
  }

  if (status === "paused") {
    return <PauseCircle className="size-4 text-primary" />;
  }

  return <PlayCircle className="size-4 text-primary" />;
}
