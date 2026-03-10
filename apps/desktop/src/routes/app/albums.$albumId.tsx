import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  Disc3,
  FolderClock,
  Music4,
  Tags,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { albumDetailQueryOptions } from "#/lib/app-state";
import { getErrorMessage } from "#/lib/err";
import { cn } from "#/lib/utils";

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

function formatItemDate(
  value: { year?: number; month?: number; day?: number } | null | undefined,
): string | null {
  if (!value?.year) {
    return null;
  }

  const segments = [value.year, value.month, value.day].filter((part): part is number => part != null);
  return segments.join("-");
}

function formatTimestamp(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function RouteComponent() {
  const { albumId } = Route.useParams();
  const albumQuery = useQuery(albumDetailQueryOptions(albumId));

  if (albumQuery.isLoading) {
    return (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
        <div className="rounded-2xl border border-dashed border-border bg-card/70 px-6 py-12 text-sm text-muted-foreground">
          Loading album details...
        </div>
      </section>
    );
  }

  if (albumQuery.isError) {
    return (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
        <Link
          to="/app/albums"
          className={cn(buttonVariants({ variant: "ghost" }), "w-fit")}
        >
          <ArrowLeft className="size-4" />
          Back to albums
        </Link>

        <Alert variant="destructive">
          <AlertTitle>Album unavailable</AlertTitle>
          <AlertDescription>
            {getErrorMessage(albumQuery.error, "The album details could not be read from the local database.")}
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!albumQuery.data) {
    return (
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
        <Link
          to="/app/albums"
          className={cn(buttonVariants({ variant: "ghost" }), "w-fit")}
        >
          <ArrowLeft className="size-4" />
          Back to albums
        </Link>

        <Card className="border-0 bg-card/85 shadow-xl shadow-primary/5 backdrop-blur">
          <CardContent className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Disc3 className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="font-medium">Album not found.</p>
              <p className="text-sm text-muted-foreground">
                This album is not currently available in the synced local library.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  const { album, artists, discTitles, genres, moods, recordLabels, releaseTypes, songs } =
    albumQuery.data;
  const albumArtists = artists.length > 0 ? artists.map((artist) => artist.name) : [];
  const headlineArtist =
    album.displayArtist ??
    album.artist ??
    (albumArtists.length > 0 ? albumArtists.join(", ") : "Unknown artist");
  const discTitlesByNumber = new Map(discTitles.map((discTitle) => [discTitle.disc, discTitle.title]));
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

  const detailItems = [
    {
      label: "Album artists",
      value: albumArtists.length > 0 ? albumArtists.join(", ") : headlineArtist,
    },
    {
      label: "Release date",
      value: formatItemDate(album.releaseDate) ?? (album.year ? String(album.year) : null),
    },
    {
      label: "Original release",
      value: formatItemDate(album.originalReleaseDate),
    },
    {
      label: "Created",
      value: formatTimestamp(album.created),
    },
    {
      label: "Last played",
      value: formatTimestamp(album.played),
    },
    {
      label: "MusicBrainz ID",
      value: album.musicBrainzId ?? null,
    },
  ].filter((item): item is { label: string; value: string } => item.value !== null);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-6 md:px-8 md:py-8">
      <Link
        to="/app/albums"
        className={cn(buttonVariants({ variant: "ghost" }), "w-fit")}
      >
        <ArrowLeft className="size-4" />
        Back to albums
      </Link>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.8fr)_minmax(300px,1fr)]">
        <Card className="border-0 bg-[radial-gradient(circle_at_top_left,rgba(193,154,77,0.18),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(58,112,110,0.14),transparent_30%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,246,241,0.92))] shadow-2xl shadow-stone-950/5 dark:bg-[radial-gradient(circle_at_top_left,rgba(193,154,77,0.16),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(58,112,110,0.18),transparent_30%),linear-gradient(180deg,rgba(36,33,29,0.95),rgba(28,26,23,0.92))]">
          <CardHeader className="gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="rounded-full px-3 py-1">
                <Disc3 className="size-3.5" />
                {album.songCount} tracks
              </Badge>
              <Badge variant="outline" className="rounded-full px-3 py-1">
                <Clock3 className="size-3.5" />
                {formatDuration(album.duration)}
              </Badge>
              {album.year ? (
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  <CalendarDays className="size-3.5" />
                  {album.year}
                </Badge>
              ) : null}
              {album.explicitStatus ? (
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  {album.explicitStatus}
                </Badge>
              ) : null}
              {album.isCompilation ? (
                <Badge variant="outline" className="rounded-full px-3 py-1">
                  Compilation
                </Badge>
              ) : null}
            </div>

            <div className="space-y-3">
              <CardTitle className="text-3xl tracking-tight md:text-4xl">{album.name}</CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2 text-base text-foreground/80">
                <UserRound className="size-4 text-muted-foreground" />
                <span>{headlineArtist}</span>
              </CardDescription>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Primary genre" value={album.genre ?? genres[0]?.value ?? "-"} />
              <StatCard
                label="Record label"
                value={recordLabels[0]?.name ?? "Unspecified"}
              />
              <StatCard
                label="Release type"
                value={releaseTypes[0]?.value ?? "Album"}
              />
              <StatCard label="Rating" value={album.userRating ? `${album.userRating}/5` : "-"} />
            </div>

            <div className="space-y-4">
              <TagCluster
                icon={<Tags className="size-4 text-muted-foreground" />}
                label="Genres"
                values={genres.map((genre) => genre.value)}
              />
              <TagCluster
                icon={<Music4 className="size-4 text-muted-foreground" />}
                label="Moods"
                values={moods.map((mood) => mood.value)}
              />
              <TagCluster
                icon={<FolderClock className="size-4 text-muted-foreground" />}
                label="Disc titles"
                values={discTitles.map((discTitle) => `Disc ${discTitle.disc}: ${discTitle.title}`)}
              />
            </div>
          </CardHeader>
        </Card>

        <Card className="border-0 bg-card/85 shadow-xl shadow-primary/5 backdrop-blur">
          <CardHeader>
            <CardTitle>Album info</CardTitle>
            <CardDescription>Fields synced from Navidrome for this album.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {detailItems.map((item) => (
              <div
                key={item.label}
                className="rounded-2xl border border-border/70 bg-background/80 px-4 py-3"
              >
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  {item.label}
                </p>
                <p className="mt-1 break-words text-sm font-medium">{item.value}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="border-0 bg-card/85 shadow-xl shadow-primary/5 backdrop-blur">
        <CardHeader className="gap-2">
          <CardTitle>Track list</CardTitle>
          <CardDescription>
            {songs.length > 0
              ? "Tracks currently stored for this album in the local database."
              : "No tracks are stored for this album."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {discSections.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-muted/35 px-6 py-12 text-sm text-muted-foreground">
              No songs are available for this album yet.
            </div>
          ) : null}

          {discSections.map((discSection) => (
            <div
              key={discSection.discNumber}
              className="overflow-hidden rounded-3xl border border-border/80 bg-background/75"
            >
              <div className="flex items-center justify-between border-b border-border/70 bg-muted/45 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold">Disc {discSection.discNumber}</p>
                  {discSection.discTitle ? (
                    <p className="text-sm text-muted-foreground">{discSection.discTitle}</p>
                  ) : null}
                </div>
                <Badge variant="outline">{discSection.songs.length} tracks</Badge>
              </div>

              <div className="divide-y divide-border/60">
                {discSection.songs.map((song) => (
                  <div
                    key={song.id}
                    className="grid gap-3 px-4 py-3 md:grid-cols-[56px_minmax(0,1fr)_minmax(120px,0.45fr)_72px] md:items-center"
                  >
                    <div className="text-sm font-medium text-muted-foreground">
                      {song.track ?? "•"}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{song.title}</p>
                      {song.comment ? (
                        <p className="truncate text-sm text-muted-foreground">{song.comment}</p>
                      ) : null}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {song.displayArtist ?? song.artist ?? "Unknown artist"}
                    </div>
                    <div className="text-sm font-medium text-muted-foreground md:text-right">
                      {formatDuration(song.duration)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/65 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function TagCluster({
  icon,
  label,
  values,
}: {
  icon: ReactNode;
  label: string;
  values: string[];
}) {
  if (values.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <Badge key={value} variant="outline" className="rounded-full px-3 py-1">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}
